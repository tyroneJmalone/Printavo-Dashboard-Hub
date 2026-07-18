import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useListQuotes } from "@workspace/api-client-react";

const SLOT_START_HOUR = 7;
const SLOT_END_HOUR = 17;
const SLOT_LENGTH_HOURS = 2;
const SLOTS_PER_DAY = Math.floor((SLOT_END_HOUR - SLOT_START_HOUR) / SLOT_LENGTH_HOURS);

function hash(n: number): number {
  let h = n ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = h ^ (h >>> 16);
  return Math.abs(h);
}

function getSlotIndex(length: number): number {
  const easternParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type: string) => Number(easternParts.find((p) => p.type === type)?.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  let hour = get("hour");
  if (hour === 24) hour = 0;

  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86400000);

  // Outside business hours, keep showing whatever the last in-hours slot was
  // (5pm's quote persists overnight) instead of burning a fresh rotation
  // when nobody's around to see it.
  let effectiveDay = dayNumber;
  let slotWithinDay: number;
  if (hour < SLOT_START_HOUR) {
    effectiveDay = dayNumber - 1;
    slotWithinDay = SLOTS_PER_DAY - 1;
  } else if (hour >= SLOT_END_HOUR) {
    slotWithinDay = SLOTS_PER_DAY - 1;
  } else {
    slotWithinDay = Math.floor((hour - SLOT_START_HOUR) / SLOT_LENGTH_HOURS);
  }

  const globalSlot = effectiveDay * SLOTS_PER_DAY + slotWithinDay;
  return hash(globalSlot) % length;
}

export function QuoteBanner() {
  const { data: quotes } = useListQuotes();
  const [, forceTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  if (!quotes || quotes.length === 0) return null;

  const quote = quotes[getSlotIndex(quotes.length)].text;

  return (
    <div className="flex items-center gap-2 rounded-lg bg-[#9e4a95]/10 border border-[#9e4a95]/25 px-4 py-2.5">
      <Sparkles className="w-5 h-5 text-[#9e4a95] shrink-0" />
      <span className="text-base font-bold text-[#9e4a95] italic truncate">{quote}</span>
    </div>
  );
}
