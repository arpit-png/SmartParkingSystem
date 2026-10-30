// Small motion kit: magnetic + ripple buttons, pointer spotlight, scroll reveal.
// Hand-written stand-ins for the AnimatedWebs components (its library tools weren't connected).
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Sets --mx/--my on the hovered element so CSS can draw a spotlight under the pointer. */
export function spotlight(e) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
}

export function Btn({ variant = "primary", magnetic = true, loading, href, className = "", children, onPointerMove, onPointerLeave, onPointerDown, ...rest }) {
  const ref = useRef(null);
  const Tag = href ? "a" : "button";

  const move = (e) => {
    spotlight(e);
    if (magnetic && e.pointerType === "mouse" && !calm()) {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty("--tx", `${(e.clientX - r.left - r.width / 2) * 0.1}px`);
      e.currentTarget.style.setProperty("--ty", `${(e.clientY - r.top - r.height / 2) * 0.18}px`);
    }
    onPointerMove?.(e);
  };
  const leave = (e) => {
    e.currentTarget.style.setProperty("--tx", "0px");
    e.currentTarget.style.setProperty("--ty", "0px");
    onPointerLeave?.(e);
  };
  const down = (e) => {
    if (!calm()) {
      const el = ref.current, r = el.getBoundingClientRect();
      const dot = document.createElement("span");
      dot.className = "ripple";
      dot.style.left = `${e.clientX - r.left}px`;
      dot.style.top = `${e.clientY - r.top}px`;
      dot.addEventListener("animationend", () => dot.remove());
      el.appendChild(dot);
    }
    onPointerDown?.(e);
  };

  return (
    <Tag ref={ref} href={href} className={`btn btn-${variant} ${className}`} aria-busy={loading || undefined}
      {...(href ? { target: "_blank", rel: "noopener noreferrer" } : { disabled: loading || rest.disabled })}
      {...rest} onPointerMove={move} onPointerLeave={leave} onPointerDown={down}>
      {loading && <Loader2 className="spin" size={18} aria-hidden />}
      {children}
    </Tag>
  );
}

/** Fades/slides content in once, the first time it scrolls into view. */
export function Reveal({ as: Tag = "div", delay = 0, className = "", children, ...rest }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!("IntersectionObserver" in window)) return setSeen(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref} className={`reveal ${seen ? "in" : ""} ${className}`} style={{ "--d": `${delay}ms` }} {...rest}>
      {children}
    </Tag>
  );
}
