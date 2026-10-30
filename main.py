#!/usr/bin/env python3
"""
ParkGrid India - Core Mobility, Vahan RC, RWA Ledger & Escrow State Machine Backend
Compatible with edge_occupancy_engine.py webhook events.
"""

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from enum import Enum
import math
from typing import Dict, List, Optional
import uuid

from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

# =====================================================================
# 1. DOMAIN ENUMS & CONSTANTS
# =====================================================================

ESCROW_MINIMUM_INR = 500.0
MICRO_INSURANCE_FEE_INR = 1.50
MICRO_INSURANCE_COVERAGE_INR = 25000.0
LANDLORD_RETURN_BUFFER_MINS = 30
OVERSTAY_GRACE_MINS = 10
OVERSTAY_SURGE_MULTIPLIER = 4.0


class FootprintCategory(str, Enum):
    TWO_WHEELER = "TWO_WHEELER"          # Motorcycles / Scooters
    COMPACT = "COMPACT_UNDER_4M"         # Hatchbacks < 4.0m
    SEDAN_MID_SUV = "SEDAN_MID_SUV"      # 4.0m - 4.5m
    LARGE_SUV = "LARGE_SUV_OVER_4_5M"    # > 4.5m length + 2.5m width clearance


class PropertyType(str, Enum):
    INDEPENDENT_DRIVEWAY = "INDEPENDENT_DRIVEWAY"  # Tier 1: Zero Hardware (QR + Phone ANPR)
    GATED_COLONY_RWA = "GATED_COLONY_RWA"          # Tier 2: Edge-AI CCTV + 65/20/15 Split
    COMMERCIAL_LOT = "COMMERCIAL_LOT"              # Tier 2: Edge-AI CCTV


class SlotOccupancyStatus(str, Enum):
    VACANT = "VACANT"
    DETECTING_ENTRY = "DETECTING_ENTRY"
    OCCUPIED = "OCCUPIED"
    DETECTING_EXIT = "DETECTING_EXIT"


class BookingStatus(str, Enum):
    BOOKED = "BOOKED"                      # ₹500 Escrow locked, navigation pin unlocked
    ACTIVE = "ACTIVE"                      # Confirmed via Edge-AI IoU or P2P QR+ANPR
    GRACE_WINDOW = "GRACE_WINDOW"          # T-minus 15m warning; 30m buffer active
    OVERSTAY_PENALTY = "OVERSTAY_PENALTY"  # >10m past end: 4x surge + Overflow triggered
    COMPLETED = "COMPLETED"                # Settled & closed


# Ordered footprint hierarchy so smaller vehicles can fit larger spots if desired,
# or strictly match max dimensions.
FOOTPRINT_RANK = {
    FootprintCategory.TWO_WHEELER: 1,
    FootprintCategory.COMPACT: 2,
    FootprintCategory.SEDAN_MID_SUV: 3,
    FootprintCategory.LARGE_SUV: 4,
}


# =====================================================================
# 2. PYDANTIC V2 SCHEMAS (Strict Validation & extra="forbid")
# =====================================================================

class StrictBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class VehicleRCProfile(StrictBaseModel):
    rc_number: str = Field(..., min_length=6, max_length=15)
    owner_name: str
    make_model: str
    length_m: float = Field(..., gt=0)
    width_m: float = Field(..., gt=0)
    footprint_category: FootprintCategory
    fastag_id: str
    escrow_mandate_balance_inr: float = Field(..., ge=0)


class ParkingSpotRecord(StrictBaseModel):
    slot_id: str
    lot_id: str
    title: str
    property_type: PropertyType
    max_length_m: float
    max_width_m: float
    supported_footprint: FootprintCategory
    hourly_rate_inr: float = Field(..., gt=0)
    lat: float
    lng: float
    qr_sticker_token: str
    is_overflow_reserve: bool = False
    occupancy_status: SlotOccupancyStatus = SlotOccupancyStatus.VACANT
    last_iou: float = 0.0
    instant_book_window: str = "09:00-18:00"
    host_kyc_digilocker_verified: bool = True
    rwa_authorization_token: Optional[str] = None


class EdgeOccupancyWebhookPayload(StrictBaseModel):
    """Exact payload sent by edge_occupancy_engine.py"""
    lot_id: str = Field(..., min_length=2, max_length=64)
    slot_id: str = Field(..., min_length=2, max_length=32)
    status: SlotOccupancyStatus
    iou: float = Field(..., ge=0.0, le=1.0)
    timestamp: float


class NearbySpot(ParkingSpotRecord):
    """Spot + live distance from the searched point, for the map search."""
    distance_m: float
    fits_vehicle: bool


class P2PZeroCapexCheckInRequest(StrictBaseModel):
    booking_id: str
    qr_sticker_token: str
    driver_lat: float
    driver_lng: float
    scanned_plate_ocr: str


class InstantBookRequest(StrictBaseModel):
    rc_number: str
    slot_id: str
    duration_hours: float = Field(..., ge=0.5, le=12.0)
    escrow_preauth_inr: float = Field(..., ge=ESCROW_MINIMUM_INR)


class RevenueSplitBreakdown(StrictBaseModel):
    gross_base_inr: float
    micro_insurance_fee_inr: float
    penalty_total_inr: float
    spot_owner_payout_inr: float      # 65% of base (RWA) or 80% (Independent) + 75% of penalty
    rwa_maintenance_payout_inr: float # 20% of base (RWA) or 0% (Independent)
    platform_commission_inr: float    # 15% of base (RWA) or 20% (Independent) + 25% of penalty
    escrow_refund_to_driver_inr: float


class BookingSession(StrictBaseModel):
    booking_id: str
    rc_number: str
    vehicle_model: str
    slot_id: str
    lot_id: str
    property_type: PropertyType
    status: BookingStatus
    hourly_rate_inr: float
    booked_start_utc: datetime
    booked_end_utc: datetime
    landlord_buffer_end_utc: datetime
    escrow_locked_inr: float
    active_checkin_utc: Optional[datetime] = None
    checkout_utc: Optional[datetime] = None
    insurance_policy_active: bool = True
    insurance_coverage_inr: float = MICRO_INSURANCE_COVERAGE_INR
    overstay_minutes: int = 0
    assigned_overflow_slot_id: Optional[str] = None
    settlement: Optional[RevenueSplitBreakdown] = None


class TimeScrubberSimRequest(StrictBaseModel):
    """Allows simulating time progression to test Grace Window, 4x Overstay Penalty & Overflow"""
    simulated_minutes_after_end: int = Field(
        ..., ge=-60, le=240,
        description="Negative = before slot end; Positive = minutes past scheduled end time"
    )


# =====================================================================
# 3. IN-MEMORY STATE STORE (Pre-seeded with Bhopal MP Nagar Micro-Zone)
# =====================================================================

class InMemoryDatabase:
    def __init__(self):
        self.vehicles: Dict[str, VehicleRCProfile] = {}
        self.spots: Dict[str, ParkingSpotRecord] = {}
        self.bookings: Dict[str, BookingSession] = {}
        self.rwa_gate_logs: List[dict] = []

    def seed(self):
        # 1. Seed Vahan RC Mock Database
        self.vehicles = {
            "MP04CJ4821": VehicleRCProfile(
                rc_number="MP04CJ4821",
                owner_name="Aarav Sharma",
                make_model="Maruti Suzuki Swift",
                length_m=3.84,
                width_m=1.73,
                footprint_category=FootprintCategory.COMPACT,
                fastag_id="FT-ICICI-998821",
                escrow_mandate_balance_inr=1200.0,
            ),
            "DL01CA9922": VehicleRCProfile(
                rc_number="DL01CA9922",
                owner_name="Priya Verma",
                make_model="Tata Nexon EV",
                length_m=3.99,
                width_m=1.81,
                footprint_category=FootprintCategory.COMPACT,
                fastag_id="FT-HDFC-443210",
                escrow_mandate_balance_inr=850.0,
            ),
            "KA05MG7788": VehicleRCProfile(
                rc_number="KA05MG7788",
                owner_name="Vikramaditya Rao",
                make_model="Toyota Fortuner 4x4",
                length_m=4.79,
                width_m=1.85,
                footprint_category=FootprintCategory.LARGE_SUV,
                fastag_id="FT-AXIS-778800",
                escrow_mandate_balance_inr=2500.0,
            ),
            "MH12AB1122": VehicleRCProfile(
                rc_number="MH12AB1122",
                owner_name="Rohan Deshmukh",
                make_model="Ather 450X Gen 3",
                length_m=1.89,
                width_m=0.74,
                footprint_category=FootprintCategory.TWO_WHEELER,
                fastag_id="UPI-AUTOPAY-1122",
                escrow_mandate_balance_inr=600.0,
            ),
        }

        # 2. Seed High-Density 1-km Micro-Zone (MP Nagar Zone-I / AIIMS Corridor)
        # Matches slot IDs S-01..S-04 from edge_occupancy_engine.py
        self.spots = {
            "S-01": ParkingSpotRecord(
                slot_id="S-01",
                lot_id="LOT_RWA_MPNAGAR_01",
                title="Shanti Niketan RWA - Stilt Bay #01",
                property_type=PropertyType.GATED_COLONY_RWA,
                max_length_m=4.15,
                max_width_m=1.90,
                supported_footprint=FootprintCategory.COMPACT,
                hourly_rate_inr=30.0,
                lat=23.2332,
                lng=77.4343,
                qr_sticker_token="QR-RWA-S01",
                rwa_authorization_token="RWA-AUTH-SN-2026",
            ),
            "S-02": ParkingSpotRecord(
                slot_id="S-02",
                lot_id="LOT_RWA_MPNAGAR_01",
                title="Shanti Niketan RWA - Wide Corner Bay #02",
                property_type=PropertyType.GATED_COLONY_RWA,
                max_length_m=5.10,
                max_width_m=2.60,
                supported_footprint=FootprintCategory.LARGE_SUV,
                hourly_rate_inr=50.0,
                lat=23.2334,
                lng=77.4345,
                qr_sticker_token="QR-RWA-S02",
                rwa_authorization_token="RWA-AUTH-SN-2026",
            ),
            "S-03": ParkingSpotRecord(
                slot_id="S-03",
                lot_id="LOT_RWA_MPNAGAR_01",
                title="Plot 14 Independent Driveway (Zero-Hardware P2P)",
                property_type=PropertyType.INDEPENDENT_DRIVEWAY,
                max_length_m=4.55,
                max_width_m=2.10,
                supported_footprint=FootprintCategory.SEDAN_MID_SUV,
                hourly_rate_inr=35.0,
                lat=23.2340,
                lng=77.4351,
                qr_sticker_token="QR-P2P-S03",
            ),
            "S-04": ParkingSpotRecord(
                slot_id="S-04",
                lot_id="LOT_RWA_MPNAGAR_01",
                title="Shanti Niketan RWA - Emergency Overflow Slot #04",
                property_type=PropertyType.GATED_COLONY_RWA,
                max_length_m=5.20,
                max_width_m=2.60,
                supported_footprint=FootprintCategory.LARGE_SUV,
                hourly_rate_inr=40.0,
                lat=23.2335,
                lng=77.4346,
                qr_sticker_token="QR-OVERFLOW-S04",
                is_overflow_reserve=True,
                rwa_authorization_token="RWA-AUTH-SN-2026",
            ),
        }


db = InMemoryDatabase()


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.seed()
    yield


app = FastAPI(
    title="ParkGrid India Core API",
    description="Two-Tier Hybrid Sensing, Vahan RC Auto-Matching, 65/20/15 RWA Split & 4x Surge Escrow Engine",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =====================================================================
# 4. CORE BUSINESS LOGIC HELPERS
# =====================================================================

def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Computes exact GPS distance in meters for Tier-1 Zero-Hardware P2P geofencing."""
    r = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def compute_settlement_ledger(
    booking: BookingSession, overstay_minutes: int = 0
) -> RevenueSplitBreakdown:
    """
    Computes exact financial split:
    - RWA Gated Colony: 65% Spot Owner / 20% RWA Maintenance Fund / 15% Platform
    - Independent Driveway / Commercial: 80% Owner / 0% RWA / 20% Platform
    - Overstay Penalty (>10 mins past booked_end_utc):
      4x hourly surge billed every 15-minute block; split 75% to Landlord, 25% to Platform.
    """
    duration_hrs = (booking.booked_end_utc - booking.booked_start_utc).total_seconds() / 3600.0
    gross_base = round(duration_hrs * booking.hourly_rate_inr, 2)

    # Calculate 4x surge penalty if overstay > 10 minutes
    penalty_total = 0.0
    if overstay_minutes > OVERSTAY_GRACE_MINS:
        fifteen_min_blocks = math.ceil(overstay_minutes / 15.0)
        surge_rate_per_block = (booking.hourly_rate_inr * OVERSTAY_SURGE_MULTIPLIER) / 4.0
        penalty_total = round(fifteen_min_blocks * surge_rate_per_block, 2)

    if booking.property_type == PropertyType.GATED_COLONY_RWA:
        owner_base = round(gross_base * 0.65, 2)
        rwa_share = round(gross_base * 0.20, 2)
        platform_base = round(gross_base - owner_base - rwa_share, 2)  # 15%
    else:
        owner_base = round(gross_base * 0.80, 2)
        rwa_share = 0.0
        platform_base = round(gross_base - owner_base, 2)  # 20%

    owner_penalty_share = round(penalty_total * 0.75, 2)
    platform_penalty_share = round(penalty_total - owner_penalty_share, 2)

    total_deducted = gross_base + MICRO_INSURANCE_FEE_INR + penalty_total
    refund = max(0.0, round(booking.escrow_locked_inr - total_deducted, 2))

    return RevenueSplitBreakdown(
        gross_base_inr=gross_base,
        micro_insurance_fee_inr=MICRO_INSURANCE_FEE_INR,
        penalty_total_inr=penalty_total,
        spot_owner_payout_inr=round(owner_base + owner_penalty_share, 2),
        rwa_maintenance_payout_inr=rwa_share,
        platform_commission_inr=round(platform_base + platform_penalty_share, 2),
        escrow_refund_to_driver_inr=refund,
    )


def find_emergency_overflow_slot(lot_id: str) -> Optional[str]:
    """Finds the designated emergency overflow bay in the micro-zone for a returning landlord."""
    for spot in db.spots.values():
        if (
            spot.lot_id == lot_id
            and spot.is_overflow_reserve
            and spot.occupancy_status == SlotOccupancyStatus.VACANT
        ):
            return spot.slot_id
    return None


# =====================================================================
# 5. API ENDPOINTS
# =====================================================================

@app.get("/api/v1/vahan/lookup/{rc_number}", response_model=VehicleRCProfile, tags=["Vahan & Inventory"])
async def lookup_vahan_rc(rc_number: str):
    """
    Queries the Vahan RC registry to fetch exact length, width, and physical footprint
    so drivers never guess subjective size labels.
    """
    normalized = rc_number.strip().upper().replace(" ", "").replace("-", "")
    vehicle = db.vehicles.get(normalized)
    if not vehicle:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"RC '{normalized}' not found. Try MP04CJ4821, DL01CA9922, KA05MG7788, or MH12AB1122.",
        )
    return vehicle


@app.get("/api/v1/spots/compatible", response_model=List[ParkingSpotRecord], tags=["Vahan & Inventory"])
async def list_compatible_spots(
    rc_number: str = Query(..., description="Vehicle Registration Number"),
    property_type: Optional[PropertyType] = Query(None, description="Filter by Property Type"),
):
    """
    Filters available Instant-Book spots strictly by exact physical vehicle dimensions
    (length + width + footprint tier) and excludes emergency overflow reserves.
    """
    vehicle = await lookup_vahan_rc(rc_number)
    compatible: List[ParkingSpotRecord] = []

    for spot in db.spots.values():
        if spot.is_overflow_reserve:
            continue
        if any(b.slot_id == spot.slot_id and b.status != BookingStatus.COMPLETED for b in db.bookings.values()):
            continue
        if spot.occupancy_status != SlotOccupancyStatus.VACANT:
            continue
        if property_type and spot.property_type != property_type:
            continue

        # Strict physical dimension check + footprint tier rank check
        if (
            vehicle.length_m <= spot.max_length_m
            and vehicle.width_m <= spot.max_width_m
            and FOOTPRINT_RANK[vehicle.footprint_category] <= FOOTPRINT_RANK[spot.supported_footprint]
        ):
            compatible.append(spot)

    return compatible


@app.get("/api/v1/spots/nearby", response_model=List[NearbySpot], tags=["Vahan & Inventory"])
async def list_nearby_spots(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius_m: float = Query(1000.0, gt=0, le=25000),
    rc_number: Optional[str] = Query(None, description="If set, fits_vehicle uses this Vahan RC"),
    property_type: Optional[PropertyType] = Query(None),
):
    """
    Map search: every spot within radius_m of (lat, lng), nearest first.
    Overflow reserves are returned (flagged) so the app can pin them after an overstay.
    shortcut: haversine scan over the in-memory dict; use ST_DWithin in database.py past a few thousand spots.
    """
    vehicle = await lookup_vahan_rc(rc_number) if rc_number else None
    out: List[NearbySpot] = []
    for spot in db.spots.values():
        if property_type and spot.property_type != property_type:
            continue
        dist = haversine_meters(lat, lng, spot.lat, spot.lng)
        if dist > radius_m:
            continue
        fits = vehicle is None or (
            vehicle.length_m <= spot.max_length_m
            and vehicle.width_m <= spot.max_width_m
            and FOOTPRINT_RANK[vehicle.footprint_category] <= FOOTPRINT_RANK[spot.supported_footprint]
        )
        record = spot.model_dump()
        if any(b.slot_id == spot.slot_id and b.status != BookingStatus.COMPLETED for b in db.bookings.values()):
            record['occupancy_status'] = SlotOccupancyStatus.OCCUPIED
        out.append(NearbySpot(**record, distance_m=round(dist, 1), fits_vehicle=fits))
    return sorted(out, key=lambda s: s.distance_m)


@app.post("/api/v1/bookings/instant", response_model=BookingSession, status_code=status.HTTP_201_CREATED, tags=["Escrow State Machine"])
async def create_instant_booking(req: InstantBookRequest):
    """
    100% Instant-Book flow (zero manual landlord approval).
    Locks the mandatory ₹500 FASTag/UPI Autopay Escrow, attaches the ₹25,000 micro-insurance
    wrapper, and reserves a mandatory 30-minute Landlord Return Buffer after the slot ends.
    """
    vehicle = await lookup_vahan_rc(req.rc_number)
    spot = db.spots.get(req.slot_id)
    if not spot:
        raise HTTPException(status_code=404, detail=f"Slot {req.slot_id} does not exist.")
    if spot.is_overflow_reserve:
        raise HTTPException(status_code=400, detail="Emergency overflow slots cannot be booked by commuters.")
    if any(b.slot_id == spot.slot_id and b.status != BookingStatus.COMPLETED for b in db.bookings.values()):
        raise HTTPException(status_code=409, detail="This bay already has an active reservation.")
    if spot.occupancy_status != SlotOccupancyStatus.VACANT:
        raise HTTPException(status_code=409, detail=f"Slot {req.slot_id} is currently {spot.occupancy_status.value}.")

    if (vehicle.length_m > spot.max_length_m or vehicle.width_m > spot.max_width_m
            or FOOTPRINT_RANK[vehicle.footprint_category] > FOOTPRINT_RANK[spot.supported_footprint]):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Dimension mismatch: {vehicle.make_model} ({vehicle.length_m}m x {vehicle.width_m}m) "
                f"exceeds slot {spot.slot_id} limits ({spot.max_length_m}m x {spot.max_width_m}m)."
            ),
        )

    if vehicle.escrow_mandate_balance_inr < req.escrow_preauth_inr:
        raise HTTPException(
            status_code=402,
            detail=f"Insufficient FASTag/UPI Autopay balance (₹{vehicle.escrow_mandate_balance_inr}) for ₹{req.escrow_preauth_inr} escrow lock.",
        )

    now = datetime.now(timezone.utc)
    booked_end = now + timedelta(hours=req.duration_hours)
    buffer_end = booked_end + timedelta(minutes=LANDLORD_RETURN_BUFFER_MINS)

    booking_id = f"BK-{uuid.uuid4().hex[:6].upper()}"
    session = BookingSession(
        booking_id=booking_id,
        rc_number=vehicle.rc_number,
        vehicle_model=vehicle.make_model,
        slot_id=spot.slot_id,
        lot_id=spot.lot_id,
        property_type=spot.property_type,
        status=BookingStatus.BOOKED,
        hourly_rate_inr=spot.hourly_rate_inr,
        booked_start_utc=now,
        booked_end_utc=booked_end,
        landlord_buffer_end_utc=buffer_end,
        escrow_locked_inr=req.escrow_preauth_inr,
    )
    session.settlement = compute_settlement_ledger(session, overstay_minutes=0)
    db.bookings[booking_id] = session

    # Log digital ANPR/QR pass for RWA Gate Security Guard console
    if spot.property_type == PropertyType.GATED_COLONY_RWA:
        db.rwa_gate_logs.append(
            {
                "booking_id": booking_id,
                "rc_number": vehicle.rc_number,
                "vehicle_model": vehicle.make_model,
                "slot_id": spot.slot_id,
                "rwa_token": spot.rwa_authorization_token,
                "gate_action": "WHITELISTED_FOR_BOOM_BARRIER",
                "timestamp_utc": now.isoformat(),
            }
        )

    return session


@app.post("/api/v1/edge/occupancy-webhook", tags=["Tier-2 Edge-AI Webhook"])
async def receive_edge_occupancy_webhook(payload: EdgeOccupancyWebhookPayload):
    """
    Receives the asynchronous webhook emitted by edge_occupancy_engine.py after
    the 30-second YOLOv8n polygon IoU temporal smoothing filter confirms a state change.
    - OCCUPIED -> Transitions matching BOOKED session to ACTIVE.
    - VACANT   -> Finalizes ACTIVE/OVERSTAY session, settles 65/20/15 split, and releases escrow.
    """
    spot = db.spots.get(payload.slot_id)
    if not spot:
        raise HTTPException(status_code=404, detail=f"Unknown slot_id '{payload.slot_id}'")

    spot.occupancy_status = payload.status
    spot.last_iou = payload.iou

    # Find active or pending booking for this slot
    active_booking: Optional[BookingSession] = None
    for b in db.bookings.values():
        if b.slot_id == payload.slot_id and b.status != BookingStatus.COMPLETED:
            active_booking = b
            break

    now = datetime.now(timezone.utc)

    if payload.status == SlotOccupancyStatus.OCCUPIED and active_booking:
        if active_booking.status == BookingStatus.BOOKED:
            active_booking.status = BookingStatus.ACTIVE
            active_booking.active_checkin_utc = now

    elif payload.status == SlotOccupancyStatus.VACANT and active_booking:
        if active_booking.status in (
            BookingStatus.ACTIVE,
            BookingStatus.GRACE_WINDOW,
            BookingStatus.OVERSTAY_PENALTY,
        ):
            active_booking.status = BookingStatus.COMPLETED
            active_booking.checkout_utc = now
            active_booking.insurance_policy_active = False
            active_booking.settlement = compute_settlement_ledger(
                active_booking, active_booking.overstay_minutes
            )

    return {
        "acknowledged": True,
        "slot_id": spot.slot_id,
        "new_occupancy_status": spot.occupancy_status,
        "linked_booking_id": active_booking.booking_id if active_booking else None,
        "linked_booking_status": active_booking.status if active_booking else None,
    }


@app.post("/api/v1/p2p/checkin", response_model=BookingSession, tags=["Tier-1 Zero-CAPEX P2P"])
async def verify_p2p_zero_capex_checkin(req: P2PZeroCapexCheckInRequest):
    """
    Tier-1 Citizen Driveway Verification (₹0 Hardware CAPEX):
    Verifies GPS Geofence (<15m from spot pin) + ₹15 Static QR token + Smartphone ANPR plate match.
    """
    booking = db.bookings.get(req.booking_id)
    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found.")

    spot = db.spots[booking.slot_id]
    if req.qr_sticker_token != spot.qr_sticker_token:
        raise HTTPException(status_code=403, detail="Invalid wall QR sticker token.")

    distance_m = haversine_meters(req.driver_lat, req.driver_lng, spot.lat, spot.lng)
    if distance_m > 15.0:
        raise HTTPException(
            status_code=400,
            detail=f"Geofence check failed: You are {distance_m:.1f}m away from the spot (must be <= 15m).",
        )

    cleaned_ocr = req.scanned_plate_ocr.strip().upper().replace(" ", "").replace("-", "")
    if cleaned_ocr != booking.rc_number:
        raise HTTPException(
            status_code=422,
            detail=f"Smartphone ANPR plate mismatch: scanned '{cleaned_ocr}', expected '{booking.rc_number}'.",
        )

    spot.occupancy_status = SlotOccupancyStatus.OCCUPIED
    booking.status = BookingStatus.ACTIVE
    booking.active_checkin_utc = datetime.now(timezone.utc)
    return booking


@app.post("/api/v1/bookings/{booking_id}/simulate-timer", response_model=BookingSession, tags=["Escrow State Machine"])
async def simulate_escrow_state_machine(booking_id: str, sim: TimeScrubberSimRequest):
    """
    Interactive State Machine Time-Scrubber:
    Test transitions across ACTIVE -> GRACE_WINDOW (T-15m) -> OVERSTAY_PENALTY (>10m past end).
    Automatically deducts 4x hourly surge from the ₹500 escrow every 15 mins and routes
    the returning landlord to the micro-zone's Emergency Overflow Slot.
    """
    booking = db.bookings.get(booking_id)
    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found.")

    if booking.status == BookingStatus.COMPLETED:
        raise HTTPException(status_code=409, detail="Completed bookings cannot be reactivated.")

    mins = sim.simulated_minutes_after_end

    if mins < -15:
        booking.status = BookingStatus.ACTIVE
        booking.overstay_minutes = 0
        booking.assigned_overflow_slot_id = None
    elif -15 <= mins <= OVERSTAY_GRACE_MINS:
        booking.status = BookingStatus.GRACE_WINDOW
        booking.overstay_minutes = max(0, mins)
        booking.assigned_overflow_slot_id = None
    else:
        booking.status = BookingStatus.OVERSTAY_PENALTY
        booking.overstay_minutes = mins
        if not booking.assigned_overflow_slot_id:
            booking.assigned_overflow_slot_id = find_emergency_overflow_slot(booking.lot_id)

    booking.settlement = compute_settlement_ledger(booking, overstay_minutes=booking.overstay_minutes)
    return booking


@app.get("/api/v1/rwa/ledger-summary", tags=["RWA & Anti-Leakage"])
async def get_rwa_dashboard_and_anti_leakage_metrics():
    """
    Returns live RWA 65/20/15 split totals, Security Gate ANPR whitelist logs,
    and the Dynamic Multi-User Yield comparison (₹3,200/mo on-app vs ₹1,500/mo off-app).
    """
    total_owner = sum(b.settlement.spot_owner_payout_inr for b in db.bookings.values() if b.settlement)
    total_rwa = sum(b.settlement.rwa_maintenance_payout_inr for b in db.bookings.values() if b.settlement)
    total_platform = sum(b.settlement.platform_commission_inr for b in db.bookings.values() if b.settlement)

    return {
        "micro_zone": "MP Nagar Zone-I / AIIMS 1-km Cluster",
        "cumulative_settlements_inr": {
            "spot_owners_65_pct_plus_penalties": round(total_owner, 2),
            "rwa_maintenance_fund_20_pct": round(total_rwa, 2),
            "platform_net_15_pct_plus_penalties": round(total_platform, 2),
        },
        "anti_leakage_yield_comparison": {
            "static_off_app_commuter_monthly_inr": 1500.0,
            "dynamic_multi_user_on_app_monthly_inr": 3200.0,
            "host_upside_pct": 113.3,
            "active_micro_insurance_per_session_inr": MICRO_INSURANCE_COVERAGE_INR,
        },
        "security_guard_anpr_gate_logs": db.rwa_gate_logs,
    }
# Optional hosted inference; credentials stay on the server.
class AssistantRequest(StrictBaseModel):
    message: str = Field(..., min_length=1, max_length=1000)


@app.get('/api/v1/health')
async def health():
    import os
    return {'status': 'ok', 'mode': 'demo', 'storage': 'in-memory',
            'assistant': 'configured-unverified' if os.getenv('HF_TOKEN') and os.getenv('HF_MODEL') else 'local-guide',
            'vahan': 'seeded-demo', 'occupancy': 'simulated-webhook'}


@app.post('/api/v1/assistant')
async def assistant(req: AssistantRequest):
    import os
    import httpx
    context = (
        'You are ParkGrid parking help. This is a Bhopal demo with seeded vehicle profiles, '
        'simulated escrow and occupancy, not real payments or insurance. '
        'RWA bays cost Rs30 or Rs50/hour, driveway Rs35/hour. '
        'Only vacant bays fitting vehicle dimensions are bookable. '
        'Escrow requires Rs500, demo insurance fee Rs1.50. '
        'Driveway check-in validates QR token, matching plate and a 15m GPS geofence. '
        'Do not claim to book anything or invent live availability. Answer briefly. '
        'Never ask for credentials or personal information.'
    )
    token, model = os.getenv('HF_TOKEN'), os.getenv('HF_MODEL')
    if token and model:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(
                    'https://router.huggingface.co/v1/chat/completions',
                    headers={'Authorization': f'Bearer {token}'},
                    json={'model': model, 'messages': [
                        {'role': 'system', 'content': context},
                        {'role': 'user', 'content': req.message}], 'max_tokens': 250},
                )
                response.raise_for_status()
                answer = response.json()['choices'][0]['message']['content']
                if not isinstance(answer, str) or not answer.strip():
                    raise ValueError('Empty inference response')
                return {'source': 'Hugging Face · AI response', 'answer': answer}
        except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError):
            source = 'Local guide · hosted model unavailable'
    else:
        source = 'Local guide · no hosted model configured'
    q = req.message.lower()
    if any(word in q for word in ['price', 'cost', 'cheap', 'rate', 'fee']):
        answer = 'Demo RWA bays start at ₹30/hour; the driveway is ₹35/hour. A ₹1.50 simulated insurance fee is added per session. Select a bay to review its full estimate.'
    elif any(word in q for word in ['check', 'plate', 'qr', 'arriv']):
        answer = 'After booking a driveway, use the QR sticker token and matching registration plate within 15 m of the bay. The trip screen includes GPS check-in and a clearly labeled simulation.'
    elif any(word in q for word in ['escrow', 'pay', 'refund', 'insurance']):
        answer = 'This sandbox simulates a ₹500 escrow hold and settlement. No money moves and no real insurance policy is issued. Your trip shows the simulated charge and refund.'
    else:
        answer = 'Choose a demo vehicle, search MP Nagar, then select a compatible vacant bay. Review the duration and estimate before booking. Your trip includes directions, check-in and settlement simulation.'
    return {'source': source, 'answer': answer}


@app.get('/api/v1/bookings/{booking_id}', response_model=BookingSession)
async def get_booking(booking_id: str):
    booking = db.bookings.get(booking_id)
    if not booking:
        raise HTTPException(status_code=404, detail='Booking not found.')
    return booking
