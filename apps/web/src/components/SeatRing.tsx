import type { KeyboardEvent, ReactNode } from 'react';

/**
 * Position of seat `index` (0-based) of `count` around an oval: the first seat
 * at the top, the rest clockwise, evenly spaced. Returns percentages of the
 * ring's width/height for the seat's centre.
 *
 * The radii are tuned together with the card size in `.seat-ring`
 * (styles.css) so neighbouring seats never overlap for 2–10 seats on rings
 * from 288px wide upwards, in both the portrait and the square layout.
 */
export function ringPosition(index: number, count: number): { x: number; y: number } {
  const angle = (index / Math.max(1, count)) * Math.PI * 2;
  return { x: 50 + 38 * Math.sin(angle), y: 50 - 40 * Math.cos(angle) };
}

/** Move focus between the ring's seats with the arrow keys (clockwise = Right/Down). */
function onRingKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  const first = e.key === 'Home';
  const last = e.key === 'End';
  if (!step && !first && !last) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.ring-slot > button, .ring-slot > [tabindex="0"]')).filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
  if (items.length === 0) return;
  const cur = items.indexOf(document.activeElement as HTMLElement);
  const next = first ? 0 : last ? items.length - 1 : cur === -1 ? 0 : (cur + step + items.length) % items.length;
  items[next].focus();
  e.preventDefault();
}

/**
 * Oval table with `seats` placed around it (seat 1 at the top, clockwise).
 * Each seat is rendered by `renderSeat`; the DOM order follows the seat
 * order, so Tab and the arrow keys move clockwise.
 */
export function SeatRing({ seats, label, center, renderSeat }: { seats: number[]; label: string; center?: ReactNode; renderSeat: (seat: number) => ReactNode }) {
  return (
    <div className="seat-ring" role="group" aria-label={label} onKeyDown={onRingKeyDown} data-count={seats.length}>
      <div className="seat-ring-felt" aria-hidden={center ? undefined : true}>
        {center}
      </div>
      {seats.map((seat, i) => {
        const { x, y } = ringPosition(i, seats.length);
        return (
          <div key={seat} className="ring-slot" style={{ left: `${x}%`, top: `${y}%` }} data-seat={seat}>
            {renderSeat(seat)}
          </div>
        );
      })}
    </div>
  );
}
