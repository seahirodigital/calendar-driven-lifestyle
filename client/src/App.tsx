import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Schedule = ApiResponse<typeof api, "getSchedule">;
type Slot = Schedule["weeks"][number]["days"][number]["slots"][number];
type Route = NonNullable<Slot["route"]>;
type Candidate = Slot["candidates"][number];
type Cafe = Slot["cafes"][number];
type FoodSettings = Schedule["settings"];
type HiddenShop = ApiResponse<typeof api, "getHiddenShops">["shops"][number];
type FeedbackEntry = ApiResponse<typeof api, "getFeedback">["entries"][number];

/** "2026年11月16日" for a feedback timestamp, in Asia/Tokyo. */
function ratedDateLabel(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(iso));
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function dayLabel(date: string): { md: string; wd: string } {
  const d = new Date(`${date}T00:00:00Z`);
  return {
    md: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
    wd: WEEKDAYS[d.getUTCDay()] ?? "",
  };
}

function timeOf(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? (m[1] ?? null) : null;
}

function eventTimeLabel(slot: Slot): string {
  if (slot.allDay) return "終日";
  const s = timeOf(slot.eventStart);
  const e = timeOf(slot.eventEnd);
  if (s && e) return `${s}–${e}`;
  if (s) return `${s}〜`;
  return "";
}

/* ---------- icons (inline SVG) ---------- */

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M12 13v4M10 15h4" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

function ExternalIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.23.6.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Small circled "!" — the hide button at a candidate card's bottom-left.
 * Tapping it puts the shop on the permanent exclusion list. */
function ExclaimIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V13" />
      <circle cx="12" cy="16.4" r="0.4" fill="currentColor" />
    </svg>
  );
}

/** Star for the rating button: outline when the shop is unrated,
 * filled (with the score next to it) once the user has rated it. */
function StarIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.6l2.5 5.2 5.7.7-4.2 4 1.1 5.6L12 16.4l-5.1 2.7L8 13.5l-4.2-4 5.7-.7z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-13M10 11v6M14 11v6" />
    </svg>
  );
}

function DotsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

function TrainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="3" width="14" height="13" rx="3" />
      <path d="M5 10h14M9.5 20l1.2-4M14.5 20l-1.2-4" />
      <circle cx="9" cy="13.2" r="0.6" fill="currentColor" />
      <circle cx="15" cy="13.2" r="0.6" fill="currentColor" />
    </svg>
  );
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function MealIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12h16M12 12v3" />
      <path d="M3 17a9 9 0 0 1 18 0z" />
      <path d="M9 7c.6-1.2 1.8-2 3-2" />
    </svg>
  );
}

function PhotoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4.5 17.5l4.5-4 3.5 3 2.5-2.2 4.5 3.7" />
    </svg>
  );
}

function CupIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h13v6a5 5 0 0 1-5 5h-3a5 5 0 0 1-5-5z" />
      <path d="M17 10h1.2A2.8 2.8 0 0 1 21 12.8 2.8 2.8 0 0 1 18.2 15.6H17" />
      <path d="M7.5 3.5c0 1 .8 1.2.8 2.2M11.5 3.5c0 1 .8 1.2.8 2.2" />
    </svg>
  );
}

function CakeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 21h16M4 21v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5" />
      <path d="M4 17c1.3 1.2 2.7 1.2 4 0 1.3 1.2 2.7 1.2 4 0 1.3 1.2 2.7 1.2 4 0 1.3 1.2 2.7 1.2 4 0" />
      <path d="M12 14V9M12 4.5a1.6 1.6 0 0 1 1.6 1.6c0 1-.8 1.4-1.6 2-.8-.6-1.6-1-1.6-2A1.6 1.6 0 0 1 12 4.5z" />
    </svg>
  );
}

/* ---------- calendar booking sheet ---------- */

type SheetTarget = {
  name: string;
  sublabel: string;
  slot: Slot;
  date: string;
  purpose: "lunch" | "cafe" | "souvenir";
  tabelogUrl?: string | null;
  mapUrl?: string | null;
  defaultStart: string;
  defaultEnd: string;
};

/** "HH:MM" of an ISO local time shifted by `deltaMin` minutes. */
function shiftedTime(iso: string | null, deltaMin: number): string | null {
  const t = timeOf(iso);
  if (!t) return null;
  const [h = 0, m = 0] = t.split(":").map(Number);
  const total = h * 60 + m + deltaMin;
  if (total < 0 || total >= 24 * 60) return null;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function cafeDefaults(slot: Slot): { start: string; end: string } {
  // Default: arrive at the cafe 1 hour before the event, stay 30 minutes.
  const start = shiftedTime(slot.eventStart, -60);
  const end = shiftedTime(slot.eventStart, -30);
  if (start && end) return { start, end };
  return { start: "10:00", end: "10:30" };
}

function BookingSheet({
  target,
  onClose,
}: {
  target: SheetTarget;
  onClose: () => void;
}) {
  const souvenir = target.purpose === "souvenir";
  const cafe = target.purpose === "cafe";
  const [date, setDate] = useState(target.date);
  const [startTime, setStartTime] = useState(target.defaultStart);
  const [endTime, setEndTime] = useState(target.defaultEnd);
  const links = useMutation({
    mutationFn: async () =>
      await api.buildCalendarLinks({
        name: target.name,
        area: target.slot.area,
        tabelogUrl: target.tabelogUrl ?? null,
        mapUrl: target.mapUrl ?? null,
        purpose: target.purpose,
        date,
        startTime,
        endTime,
      }),
  });
  const mutateRef = useRef(links.mutate);
  mutateRef.current = links.mutate;
  useEffect(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && startTime < endTime) {
      mutateRef.current();
    }
  }, [date, startTime, endTime]);

  const downloadIcs = () => {
    if (!links.data) return;
    const blob = new Blob([links.data.ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = souvenir ? "souvenir.ics" : cafe ? "cafe.ics" : "lunch.ics";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${target.name}をカレンダーに追加`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[var(--surface)] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl rounded-t-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-[var(--dim)]">
              {souvenir
                ? "お土産の立ち寄り予定として追加"
                : cafe
                  ? "打ち合わせ前のカフェ予定として追加"
                  : "ランチ予定として追加"}
            </p>
            <h3 className="mt-1 text-lg font-semibold leading-snug">{target.name}</h3>
            <p className="mt-0.5 text-sm text-[var(--dim)]">{target.sublabel}</p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <label className="col-span-3 text-sm sm:col-span-1">
            <span className="mb-1 block text-xs text-[var(--dim)]">日付</span>
            <input
              type="date"
              aria-label="予定の日付"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[var(--dim)]">開始</span>
            <input
              type="time"
              aria-label="開始時刻"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[var(--dim)]">終了</span>
            <input
              type="time"
              aria-label="終了時刻"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm"
            />
          </label>
        </div>

        <div className="mt-5 flex flex-col gap-2">
          {links.data ? (
            <a
              href={links.data.googleUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white"
            >
              <CalendarIcon className="h-4.5 w-4.5" />
              Googleカレンダーに追加
            </a>
          ) : (
            <span className="flex min-h-11 items-center justify-center rounded-xl bg-[var(--border)] px-4 py-2.5 text-sm text-[var(--dim)]">
              {links.isPending ? "リンクを作成中…" : "日時を選んでください"}
            </span>
          )}
          <button
            type="button"
            onClick={downloadIcs}
            disabled={!links.data}
            className="min-h-11 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-medium disabled:opacity-40"
          >
            .icsファイルをダウンロード
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- rating sheet (the user's own score + memo for a shop) --- */

type FeedbackTarget = { candidate: Candidate; area: string };

/** Rating editor for one shop, opened from the star button on a
 * candidate card. A native <dialog> opened with showModal() (Modern
 * Web Guidance, dialog guide): the browser traps focus, returns focus
 * to the card button on close, and handles Esc / back-gesture.
 * closedby="any" adds backdrop light-dismiss where supported; the
 * pointer fallback below covers browsers without closedBy (Safari).
 * The score control is a native <input type="range"> (slider guide):
 * 0–5 in 0.1 steps, starting at the existing rating or 3.5 for a
 * first rating; the value is exposed as text and via aria-valuetext. */
function FeedbackSheet({
  target,
  onClose,
}: {
  target: FeedbackTarget;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sliderId = useId();
  const memoId = useId();
  const titleId = useId();
  const existing = target.candidate.userRating;
  const [rating, setRating] = useState(existing ?? 3.5);
  const [memo, setMemo] = useState(target.candidate.userMemo ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
    // Light-dismiss fallback for browsers without `closedBy` support:
    // close only when the press AND the release both land outside the
    // dialog's content box (a text-selection drag ending on the
    // backdrop must not dismiss).
    if ("closedBy" in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const outside = (e: PointerEvent) => {
      const r = d.getBoundingClientRect();
      return (
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
      );
    };
    const down = (e: PointerEvent) => {
      pressedOutside = outside(e);
    };
    const up = (e: PointerEvent) => {
      if (pressedOutside && outside(e)) d.close();
    };
    d.addEventListener("pointerdown", down);
    d.addEventListener("pointerup", up);
    return () => {
      d.removeEventListener("pointerdown", down);
      d.removeEventListener("pointerup", up);
    };
  }, []);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["schedule"] });
    queryClient.invalidateQueries({ queryKey: ["feedback"] });
  };
  const save = useMutation({
    mutationFn: async () =>
      await api.saveFeedback({
        tabelogUrl: target.candidate.tabelogUrl ?? "",
        name: target.candidate.name,
        rating,
        memo,
        area: target.area,
        genre: target.candidate.genre,
        photoUrl: target.candidate.photoUrl,
      }),
    onSuccess: () => {
      invalidate();
      dialogRef.current?.close();
    },
    onError: () => setError("保存できませんでした。少し待って再度お試しください。"),
  });
  const remove = useMutation({
    mutationFn: async () =>
      await api.deleteFeedback({ tabelogUrl: target.candidate.tabelogUrl ?? "" }),
    onSuccess: () => {
      invalidate();
      dialogRef.current?.close();
    },
    onError: () => setError("削除できませんでした。少し待って再度お試しください。"),
  });

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: "any" } as Record<string, string>)}
      aria-labelledby={titleId}
      onClose={onClose}
      className="feedback-dialog m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-[var(--text)] shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={titleId} className="text-lg font-semibold leading-snug">
            {target.candidate.name}
          </h3>
          <p className="mt-0.5 text-sm text-[var(--dim)]">
            食べログ {target.candidate.score.toFixed(2)}
            {target.area ? ` ・ ${target.area}` : ""}
          </p>
        </div>
        <button
          type="button"
          aria-label="閉じる"
          onClick={() => dialogRef.current?.close()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg leading-none"
        >
          ×
        </button>
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={sliderId} className="text-sm font-semibold">
            自分の評価
          </label>
          <p aria-hidden="true" className="text-xl font-bold leading-none text-[var(--accent)]">
            ★{rating.toFixed(1)}
            <span className="ml-1 text-[13px] font-medium text-[var(--dim)]">/ 5.0</span>
          </p>
        </div>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={rating}
          aria-valuetext={`${rating.toFixed(1)}点（5点満点）`}
          onChange={(e) => setRating(Number(e.target.value))}
          className="rating-slider mt-1"
          style={{ "--slider-progress": `${(rating / 5) * 100}%` } as CSSProperties}
        />
        <div aria-hidden="true" className="flex justify-between text-[11px] text-[var(--dim)]">
          <span>0.0</span>
          <span>5.0</span>
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor={memoId} className="text-sm font-semibold">
          メモ
        </label>
        <textarea
          id={memoId}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          rows={3}
          className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm leading-relaxed"
        />
      </div>

      {error && <p className="mt-3 text-sm text-[#c92a2a] dark:text-[#ff8787]">{error}</p>}

      <div className="mt-5 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending || remove.isPending}
          className="min-h-11 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : "評価を保存"}
        </button>
        {existing != null && (
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={save.isPending || remove.isPending}
            className="min-h-11 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-medium text-[#c92a2a] disabled:opacity-50 dark:text-[#ff8787]"
          >
            {remove.isPending ? "削除中…" : "評価を削除"}
          </button>
        )}
      </div>
    </dialog>
  );
}

/* ---------- train route (home stations -> destination station) ---------- */

function routeSummary(route: Route): string {
  const fare = route.fareIcYen != null ? `IC ¥${route.fareIcYen.toLocaleString()}` : "運賃未確認";
  const time = route.durationMin != null ? `約${route.durationMin}分` : "所要時間未確認";
  const transfers = route.transfers === 0 ? "乗換なし" : `乗換${route.transfers}回`;
  return `${route.originStation}→${route.destStation} ${time}・${fare}・${transfers}`;
}

/** Yahoo!路線 search link for a route (user instruction, 2026-11-16,
 * replacing the old NAVITIME search link). For a slot with a timed
 * event, the link is an ARRIVAL-time search (type=4) pinned to the
 * event's start time on the event day, so Yahoo back-calculates the
 * departure that still gets the user there in time. Slots without a
 * timed event (home-area fallback days, all-day events) get the same link
 * shape with no date/time parameters. Parameter format verified live
 * against transit.yahoo.co.jp on 2026-11-16: from/to are the station
 * names without the 駅 suffix; y/m/d the date; hh + m1 (tens) + m2
 * (ones) the time; type=4 到着時刻指定 (type=2 would be 終電). */
function yahooRouteUrl(route: Route, slot: Slot): string {
  const from = encodeURIComponent(route.originStation.replace(/駅$/, ""));
  const to = encodeURIComponent(route.destStation.replace(/駅$/, ""));
  const base = `https://transit.yahoo.co.jp/search/result?from=${from}&to=${to}`;
  if (slot.kind !== "event" || slot.allDay || !slot.eventStart) return base;
  const m = slot.eventStart.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return base;
  const [, y, mo, d, hh, mm] = m;
  if (!y || !mo || !d || !hh || !mm) return base;
  const m1 = mm.charAt(0);
  const m2 = mm.charAt(1);
  return `${base}&y=${y}&m=${mo}&d=${d}&hh=${hh}&m1=${m1}&m2=${m2}&type=4`;
}

/** Inline route detail, rendered inside the 行き方 accordion panel. */
function RouteDetail({ route, slot }: { route: Route; slot: Slot }) {
  return (
    <div>
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[13px] font-medium">
          運賃 {route.fareIcYen != null ? `IC ¥${route.fareIcYen.toLocaleString()}` : "未確認"}
        </span>
        <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[13px] font-medium">
          所要 {route.durationMin != null ? `約${route.durationMin}分（乗換待ち含む）` : "未確認"}
        </span>
        <span className="rounded-full border border-[var(--border)] px-2.5 py-1 text-[13px] font-medium">
          {route.transfers === 0 ? "乗換なし" : `乗換${route.transfers}回`}
        </span>
      </div>

      <ol className="mt-4">
        {route.legs.map((leg, i) => (
          <li key={`${leg.line}-${leg.fromStation}`} className="relative pl-6">
            <span
              aria-hidden="true"
              className="absolute left-[5px] top-2 h-2.5 w-2.5 rounded-full bg-[var(--accent)]"
            />
            {i < route.legs.length - 1 && (
              <span aria-hidden="true" className="absolute bottom-0 left-[10px] top-5 w-px bg-[var(--border)]" />
            )}
            <div className="pb-4">
              <p className="text-[15px] font-semibold leading-snug">
                {leg.fromStation}
                <span className="mx-1 font-normal text-[var(--dim)]">→</span>
                {leg.toStation}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[var(--dim)]">
                <span className="rounded-full bg-[var(--accent)] px-2 py-px text-[12px] font-semibold text-white">
                  {leg.line}
                </span>
                <span>
                  {leg.stops > 0 ? `${leg.stops}駅` : ""}
                  {leg.minutes > 0 ? ` ・ 約${leg.minutes}分` : ""}
                </span>
              </p>
              {leg.note && <p className="mt-0.5 text-[13px] text-[var(--dim)]">{leg.note}</p>}
              {i < route.legs.length - 1 && (
                <p className="mt-2 inline-block rounded-lg border border-[var(--border)] px-2 py-1 text-[12px] font-medium">
                  乗換：{leg.toStation}で{route.legs[i + 1]?.line}へ
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {route.note && <p className="text-[13px] leading-relaxed text-[var(--dim)]">{route.note}</p>}
      {/* The external search link is Yahoo!路線 (user instruction,
          2026-11-16, replacing NAVITIME): arrival-time search pinned
          to the event start for timed event slots, plain from→to
          search otherwise. The stored summary above (fares/times
          verified on 駅探) is unchanged; the 出典 line below keeps
          naming that source. */}
      <p className="mt-2">
        <a
          href={yahooRouteUrl(route, slot)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-8 items-center gap-1 text-sm font-medium text-[var(--accent)]"
        >
          Yahoo!路線で検索
          <ExternalIcon className="h-3.5 w-3.5" />
        </a>
      </p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
        出典：{route.sourceLabel || "路線検索で確認"}
      </p>
    </div>
  );
}

/* ---------- candidate card ---------- */

/** One Tabelog candidate card. Used in both the lunch and the
 * souvenir-sweets horizontal rails (rail=true, fixed width) — the
 * sweets cards share the lunch card's exact size and layout
 * (user instruction, 2026-11-16).
 * The top carries the shop's photo thumbnail (user instruction,
 * 2026-11-15: pick visually). photoUrl is the shop's own real photo
 * from its Tabelog page (or the documented fallbacks); rows saved
 * before photos were collected have none yet — they render a
 * "写真を調査中" loading tile (never a blank or initial-letter tile)
 * until the next refresh fills the photo in. A photo that fails to
 * load falls back to the same tile.
 * Always shows the shop's Tabelog business hours (or 営業時間 未確認）
 * and any server-computed closed-during-this-slot warning. The small
 * circled-! button at the bottom-left hides the shop permanently
 * (exclusion list) — there is no swipe-delete and no trash button.
 * Next to it sits the rating button (user instruction, 2026-11-16):
 * a star outline when unrated, ★<score> once the user rated the shop;
 * tapping opens the rating sheet (slider + memo, stored per shop). */
function CandidateCard({
  candidate,
  purpose,
  rail,
  onBook,
  onHide,
  onRate,
  onShare,
}: {
  candidate: Candidate;
  purpose: "lunch" | "souvenir";
  rail?: boolean;
  onBook: () => void;
  onHide: () => void;
  onRate: () => void;
  onShare: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [candidate.photoUrl]);
  const showPhoto = Boolean(candidate.photoUrl) && !imgFailed;
  return (
    <div
      role="listitem"
      aria-label={candidate.name}
      className={`flex flex-col rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3 ${
        rail ? "h-full w-[248px] shrink-0 snap-start" : "w-full"
      }`}
    >
      {/* Media region: the img itself carries a fixed aspect-ratio with
          object-fit: cover (Modern Web Guidance, card), and the
          no-photo tile is the exact same box, so every card in a rail
          has an identical media height — no ragged tops. Tapping the
          photo (or the loading tile) opens the shop's Tabelog page in
          a new tab (user instruction, 2026-11-16). */}
      {candidate.tabelogUrl ? (
        <a
          href={candidate.tabelogUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`${candidate.name}を食べログで見る`}
          className="-mx-3 -mt-3 mb-3 block shrink-0 overflow-hidden rounded-t-[11px]"
        >
          {showPhoto ? (
            <img
              src={candidate.photoUrl ?? undefined}
              alt={`${candidate.name}の写真`}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="block aspect-[2/1] w-full object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex aspect-[2/1] w-full animate-pulse flex-col items-center justify-center gap-1.5 bg-[var(--border)] text-[var(--dim)]"
            >
              <PhotoIcon className="h-7 w-7" />
              <span className="text-xs font-medium">写真を調査中</span>
            </span>
          )}
        </a>
      ) : (
        <div className="-mx-3 -mt-3 mb-3 shrink-0 overflow-hidden rounded-t-[11px]">
          {showPhoto ? (
            <img
              src={candidate.photoUrl ?? undefined}
              alt={`${candidate.name}の写真`}
              loading="lazy"
              onError={() => setImgFailed(true)}
              className="block aspect-[2/1] w-full object-cover"
            />
          ) : (
            <div
              aria-label="写真を調査中"
              className="flex aspect-[2/1] w-full animate-pulse flex-col items-center justify-center gap-1.5 bg-[var(--border)] text-[var(--dim)]"
            >
              <PhotoIcon className="h-7 w-7" />
              <span className="text-xs font-medium">写真を調査中</span>
            </div>
          )}
        </div>
      )}
      <div className="flex items-start gap-2.5">
        <div
          className="flex h-11 w-12 shrink-0 flex-col items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: "var(--accent)" }}
          aria-label={`食べログ評価 ${candidate.score.toFixed(2)}`}
        >
          <span className="text-[15px] font-bold leading-none">{candidate.score.toFixed(2)}</span>
          <span className="mt-0.5 text-[9px] leading-none opacity-90">食べログ</span>
        </div>
        <p className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">
          {candidate.name}
        </p>
        <button
          type="button"
          onClick={onBook}
          aria-label={
            purpose === "souvenir"
              ? `${candidate.name}への立ち寄りをカレンダーに追加`
              : `${candidate.name}のランチをカレンダーに追加`
          }
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--accent)]"
        >
          <CalendarIcon className="h-4.5 w-4.5" />
        </button>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[var(--dim)]">
        {candidate.genre && <span>{candidate.genre}</span>}
        {candidate.priceLabel && <span>{candidate.priceLabel}</span>}
      </p>
      <p className="mt-1 flex items-start gap-1 text-[13px] leading-relaxed">
        <ClockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--dim)]" />
        <span>
          <span className="text-[var(--dim)]">営業時間：</span>
          {candidate.hoursText || "未確認"}
          {candidate.closedDays && (
            <span className="block">
              <span className="text-[var(--dim)]">定休日：</span>
              {candidate.closedDays}
            </span>
          )}
        </span>
      </p>
      {candidate.hoursWarning && (
        <p className="mt-1 flex items-start gap-1 text-[13px] font-medium leading-relaxed text-[#c92a2a] dark:text-[#ff8787]">
          <ExclaimIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {candidate.hoursWarning}
        </p>
      )}
      {candidate.note && (
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--dim)]">{candidate.note}</p>
      )}
      <div className="mt-auto flex items-end justify-between gap-2 pt-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onHide}
            aria-label={`${candidate.name}を今後表示しない（除外リストに追加）`}
            title="この店を今後表示しない"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--dim)]"
          >
            <ExclaimIcon className="h-5 w-5" />
          </button>
          {(candidate.tabelogUrl || candidate.userRating != null) && (
            <button
              type="button"
              onClick={onRate}
              aria-label={
                candidate.userRating != null
                  ? `${candidate.name}の自分の評価 ★${candidate.userRating.toFixed(1)}（タップで変更）`
                  : `${candidate.name}を評価する`
              }
              title={candidate.userRating != null ? "自分の評価を変更" : "この店を評価する"}
              className={`flex h-8 items-center justify-center gap-0.5 rounded-full ${
                candidate.userRating != null
                  ? "px-1.5 font-semibold text-[var(--accent)]"
                  : "w-8 text-[var(--dim)]"
              }`}
            >
              <StarIcon className="h-5 w-5" filled={candidate.userRating != null} />
              {candidate.userRating != null && (
                <span className="text-[13px] leading-none">{candidate.userRating.toFixed(1)}</span>
              )}
            </button>
          )}
          {candidate.tabelogUrl && (
            <button
              type="button"
              onClick={onShare}
              aria-label={`${candidate.name}を共有`}
              title="この店を共有"
              className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--dim)]"
            >
              <ShareIcon className="h-5 w-5" />
            </button>
          )}
        </div>
        {candidate.mapUrl && (
          <a
            href={candidate.mapUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`${candidate.name}の地図を見る`}
            className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-[var(--accent)]"
          >
            <PinIcon className="h-3.5 w-3.5" />
            地図を見る
          </a>
        )}
      </div>
    </div>
  );
}

/* ---------- cafe card (horizontal rail) + detail ---------- */

const BRAND_TILE_COLORS = [
  "#1d6f4e", // スターバックス系の深緑
  "#8a5a2b",
  "#31597f",
  "#7a3b4f",
  "#4a5d23",
  "#5b4a8a",
];

function brandTileColor(brand: string): string {
  let h = 0;
  for (let i = 0; i < brand.length; i++) h = (h * 31 + (brand.charCodeAt(i) ?? 0)) % 997;
  return BRAND_TILE_COLORS[h % BRAND_TILE_COLORS.length] ?? "#1d6f4e";
}

type CafeLocationType = Cafe["locationType"];

function cafeLocationLabel(t: CafeLocationType): string {
  return t === "inside" ? "駅中" : t === "outside" ? "駅外" : "未判定";
}

function cafeLocationDetail(t: CafeLocationType): string {
  return t === "inside"
    ? "駅中（改札内・コンコース内・エキナカ等）"
    : t === "outside"
      ? "駅外（駅ビル・路面店など）"
      : "未判定（次回調査で判定します）";
}

/** Small 駅中/駅外/未判定 badge shown on every cafe card and detail. */
function CafeLocationBadge({ type }: { type: CafeLocationType }) {
  const label = cafeLocationLabel(type);
  const cls =
    type === "inside"
      ? "bg-[var(--accent)] text-white border-transparent"
      : type === "outside"
        ? "bg-[var(--surface)] text-[var(--text)] border-[var(--border)]"
        : "bg-[var(--surface)] text-[var(--dim)] border-dashed border-[var(--border)]";
  return (
    <span
      className={`inline-block shrink-0 rounded-full border px-1.5 py-px text-[10.5px] font-bold leading-tight ${cls}`}
      aria-label={`区分：${cafeLocationDetail(type)}`}
    >
      {label}
    </span>
  );
}

/** One shop card in a brand's horizontal rail: photo thumbnail (real shop
 * photo when the database has one) or a brand tile, plus the shop name.
 * Tapping the name area selects the shop and shows its detail under the
 * rail; tapping the photo area opens the shop's map link in a new tab
 * (user instruction, 2026-11-16) — the two never trigger each other. */
function CafeCard({
  cafe,
  selected,
  onSelect,
}: {
  cafe: Cafe;
  selected: boolean;
  onSelect: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const showPhoto = cafe.photoUrl && !imgFailed;
  /* Media region: fixed aspect-ratio on the img itself (object-fit:
     cover); the brand tile is the exact same box, so all cards in
     the rail share one media height. */
  const media = showPhoto ? (
    <img
      src={cafe.photoUrl ?? undefined}
      alt={`${cafe.name}の店舗写真`}
      loading="lazy"
      onError={() => setImgFailed(true)}
      className="block aspect-[5/3] w-full shrink-0 object-cover"
    />
  ) : (
    <span
      aria-hidden="true"
      className="flex aspect-[5/3] w-full shrink-0 flex-col items-center justify-center gap-1 text-white"
      style={{ backgroundColor: brandTileColor(cafe.chainName || cafe.name) }}
    >
      <CupIcon className="h-6 w-6" />
      <span className="px-1 text-center text-[11px] font-semibold leading-tight">
        {cafe.chainName || "個人経営"}
      </span>
    </span>
  );
  return (
    <div
      role="listitem"
      className={`flex h-full w-[128px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border ${
        selected
          ? "border-[var(--accent)] ring-2 ring-[var(--accent)]"
          : "border-[var(--border)]"
      } bg-[var(--surface)]`}
    >
      {cafe.mapUrl ? (
        <a
          href={cafe.mapUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`${cafe.name}の場所を地図で見る`}
          className="block shrink-0"
        >
          {media}
        </a>
      ) : (
        media
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${cafe.name}の詳細を表示`}
        className="block w-full flex-1 px-2 py-1.5 text-left"
      >
        <span className="block text-[12.5px] font-semibold leading-snug line-clamp-2 min-h-[2.4em]">
          {cafe.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1">
          <CafeLocationBadge type={cafe.locationType} />
          {cafe.address && (
            <span className="min-w-0 truncate text-[11px] text-[var(--dim)]">
              {cafe.address}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

/** Detail of the rail-selected cafe: address, note (hours etc. only when
 * verified), mandatory map link, per-shop calendar booking, and the
 * database provenance (source + researched date). */
function CafeDetail({ cafe, onBook }: { cafe: Cafe; onBook: () => void }) {
  return (
    <div className="mt-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[15px] font-semibold leading-snug">{cafe.name}</p>
        <button
          type="button"
          onClick={onBook}
          aria-label={`${cafe.name}でのカフェ時間をカレンダーに追加`}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--accent)]"
        >
          <CalendarIcon className="h-4.5 w-4.5" />
        </button>
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--dim)]">
        <span className="rounded-full border border-[var(--border)] px-1.5 py-px text-[11px]">
          {cafe.chainName ? `チェーン：${cafe.chainName}` : "個人経営"}
        </span>
        <CafeLocationBadge type={cafe.locationType} />
        <span className="text-[12px]">区分：{cafeLocationDetail(cafe.locationType)}</span>
        {cafe.address && <span>{cafe.address}</span>}
      </p>
      {cafe.note && <p className="mt-0.5 text-[13px] text-[var(--dim)]">{cafe.note}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3">
        {cafe.mapUrl && (
          <a
            href={cafe.mapUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`${cafe.name}の場所を地図で見る`}
            className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-[var(--accent)]"
          >
            <PinIcon className="h-3.5 w-3.5" />
            地図で見る
          </a>
        )}
        <button
          type="button"
          onClick={onBook}
          className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-[var(--accent)]"
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          カレンダーに追加
        </button>
      </div>
    </div>
  );
}

/* ---------- cafe section (brand pulldown + horizontal rail) ---------- */

/** Brand picker for the cafe panel (user instruction, 2026-11-15):
 * the per-brand accordions made the panel grow taller with every new
 * brand, so brands are now chosen from ONE native <select> pulldown
 * (options read 「ブランド名（N店舗）」) and only the chosen brand's
 * shops render, as a horizontal thumbnail rail. The select is styled
 * with appearance: base-select per Modern Web Guidance
 * (branded-select-styling) in theme.css; browsers without support
 * fall back to the standard native select UI. */
function CafeSection({
  slot,
  onBookCafe,
}: {
  slot: Slot;
  onBookCafe: (cafe: Cafe) => void;
}) {
  const [brandKey, setBrandKey] = useState<string | null>(null);
  const [selectedCafeId, setSelectedCafeId] = useState<number | null>(null);
  // Group by brand; independent shops (no chainName) fall into one
  // その他 group. ALL shops of a brand are listed — which shop is
  // reachable depends on its exact location.
  const groups: { key: string; label: string; cafes: Cafe[] }[] = [];
  for (const cafe of slot.cafes) {
    const key = cafe.chainName || "__independent__";
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label: cafe.chainName || "その他（個人経営）", cafes: [] };
      groups.push(g);
    }
    g.cafes.push(cafe);
  }
  // Brand order (user instruction, 2026-11-16): スターバックス first,
  // then タリーズ, then ドトール; every other brand follows in stored
  // order and independent shops come last. Display-side sort only —
  // the stored order is untouched. Array.prototype.sort is stable, so
  // equal-rank brands keep their stored relative order.
  const brandRank = (key: string): number =>
    key === "スターバックス"
      ? 0
      : key === "タリーズ"
        ? 1
        : key === "ドトール"
          ? 2
          : key === "__independent__"
            ? 4
            : 3;
  groups.sort((a, b) => brandRank(a.key) - brandRank(b.key));
  // Initial selection: スターバックス whenever this station has one
  // (it now sorts first), otherwise the first brand in the order above.
  // A stored selection that no longer exists (data refreshed) falls
  // back the same way.
  const active =
    groups.find((g) => g.key === brandKey) ?? groups[0] ?? null;
  // Within the selected brand, shops split into 駅中 / 駅外 / 未判定
  // groups (user rule change, 2026-11-15: classification replaces the
  // old station-interior exclusion — both kinds are shown).
  const locationGroups: {
    key: CafeLocationType;
    label: string;
    desc: string;
    cafes: Cafe[];
  }[] = active
    ? (
        [
          {
            key: "inside",
            label: "駅中",
            desc: "改札内・コンコース内・エキナカ等",
            cafes: active.cafes.filter((c) => c.locationType === "inside"),
          },
          {
            key: "outside",
            label: "駅外",
            desc: "駅ビル・路面店など",
            cafes: active.cafes.filter((c) => c.locationType === "outside"),
          },
          {
            key: "unknown",
            label: "未判定",
            desc: "区分を調査中（次回調査で判定）",
            cafes: active.cafes.filter((c) => c.locationType === "unknown"),
          },
        ] as const
      ).filter((g) => g.cafes.length > 0)
    : [];
  const selectId = `cafe-brand-${slot.id}`;
  const selectedCafe =
    active?.cafes.find((c) => c.id === selectedCafeId) ?? null;
  return (
    <div>
      {active ? (
        <div className="mt-2">
          <select
            id={selectId}
            name={`cafe-brand-${slot.id}`}
            aria-label="カフェブランドを選択"
            className="brand-select w-full"
            value={active.key}
            onChange={(e) => {
              setBrandKey(e.target.value);
              setSelectedCafeId(null);
            }}
          >
            {groups.map((g) => {
              const inside = g.cafes.filter(
                (c) => c.locationType === "inside",
              ).length;
              const outside = g.cafes.filter(
                (c) => c.locationType === "outside",
              ).length;
              const unknown = g.cafes.length - inside - outside;
              const parts = [
                inside > 0 ? `駅中${inside}` : "",
                outside > 0 ? `駅外${outside}` : "",
                unknown > 0 ? `未判定${unknown}` : "",
              ].filter(Boolean);
              return (
                <option key={g.key} value={g.key}>
                  {`${g.label}（${g.cafes.length}店舗${parts.length ? `・${parts.join("／")}` : ""}）`}
                </option>
              );
            })}
          </select>
          {/* The selected brand's shops, split into 駅中 / 駅外 (and
              未判定 when present) groups — each group is a heading plus
              its own horizontal thumbnail rail. Switching brands stays
              one pulldown away; the panel grows by groups, not brands. */}
          {locationGroups.map((g) => (
            <div key={g.key} className="mt-2">
              <p className="flex items-baseline gap-2">
                <CafeLocationBadge type={g.key} />
                <span className="text-[13px] font-semibold">
                  {g.label}（{g.cafes.length}店舗）
                </span>
                <span className="text-[11px] text-[var(--dim)]">{g.desc}</span>
              </p>
              <div
                data-hscroll="true"
                role="list"
                aria-label={`${active.label}の${g.label}の店舗（横スクロール）`}
                className="mt-1.5 flex snap-x gap-2 overflow-x-auto pb-2"
              >
                {g.cafes.map((cafe) => (
                  <CafeCard
                    key={cafe.id}
                    cafe={cafe}
                    selected={selectedCafeId === cafe.id}
                    onSelect={() =>
                      setSelectedCafeId(
                        selectedCafeId === cafe.id ? null : cafe.id,
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))}
          {selectedCafe && (
            <CafeDetail
              cafe={selectedCafe}
              onBook={() => onBookCafe(selectedCafe)}
            />
          )}
        </div>
      ) : (
        <p className="py-2 text-[13px] text-[var(--dim)]">
          {slot.status === "ready"
            ? "この駅周辺のカフェはまだ見つかっていません。次回更新で再調査します。"
            : "この駅周辺のカフェを調査中です。"}
        </p>
      )}
    </div>
  );
}

/* ---------- slot accordion ---------- */

type SectionKey = "meal" | "cafe" | "sweets" | "route";

function AccordionItem({
  baseId,
  slotId,
  section,
  icon,
  label,
  summary,
  openKeys,
  onToggle,
  children,
}: {
  baseId: string;
  slotId: number | string;
  section: SectionKey;
  icon: ReactNode;
  label: string;
  summary: string;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  children: ReactNode;
}) {
  const key = `${slotId}:${section}`;
  // Non-exclusive accordion (user instruction, 2026-11-16): every
  // section opens and closes independently — opening カフェ never
  // closes スイーツ.
  const open = openKeys.has(key);
  const panelId = `${baseId}-panel-${slotId}-${section}`;
  const btnId = `${baseId}-btn-${slotId}-${section}`;
  return (
    <div className="border-t border-[var(--border)] first:border-t-0">
      <h4>
        <button
          type="button"
          id={btnId}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${label}：${summary}（${open ? "閉じる" : "開く"}）`}
          onClick={() => onToggle(key)}
          className={`flex min-h-11 w-full items-center gap-2 py-2 text-left ${
            open ? "text-[var(--accent)]" : ""
          }`}
        >
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
              open
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--bg)] text-[var(--accent)]"
            }`}
          >
            {icon}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 text-[15px] font-semibold">{label}</span>
            <span className="min-w-0 truncate text-[13px] font-normal text-[var(--dim)]">
              {summary}
            </span>
          </span>
          <ChevronIcon
            className={`h-5 w-5 shrink-0 text-[var(--dim)] transition-transform duration-200 ${
              open ? "rotate-180 text-[var(--accent)]" : ""
            }`}
          />
        </button>
      </h4>
      {open && (
        <div id={panelId} role="region" aria-labelledby={btnId} className="pb-2 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

/* ---------- slot block ---------- */

function SlotBlock({
  slot,
  date,
  settings,
  baseId,
  openKeys,
  onToggle,
  onBook,
  onHideCandidate,
  onRateCandidate,
  onShareCandidate,
}: {
  slot: Slot;
  date: string;
  settings: FoodSettings;
  baseId: string;
  openKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onBook: (t: SheetTarget) => void;
  onHideCandidate: (c: Candidate) => void;
  onRateCandidate: (c: Candidate) => void;
  onShareCandidate: (c: Candidate) => void;
}) {
  const isHome = slot.kind === "home";
  const researching = slot.status === "researching";
  const bookCandidate = (c: Candidate, purpose: "lunch" | "souvenir") =>
    onBook({
      name: c.name,
      sublabel: `食べログ ${c.score.toFixed(2)}${c.priceLabel ? ` ・ ${c.priceLabel}` : ""}`,
      slot,
      date,
      purpose,
      tabelogUrl: c.tabelogUrl,
      defaultStart: purpose === "souvenir" ? "17:00" : "11:30",
      defaultEnd: purpose === "souvenir" ? "17:30" : "12:30",
    });
  const bookCafe = (cafe: Cafe) => {
    const d = cafeDefaults(slot);
    onBook({
      name: cafe.name,
      sublabel: [cafe.chainName || "個人経営", cafe.address].filter(Boolean).join(" ・ "),
      slot,
      date,
      purpose: "cafe",
      mapUrl: cafe.mapUrl,
      defaultStart: d.start,
      defaultEnd: d.end,
    });
  };
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3
            className="text-[17px] font-semibold leading-snug"
            style={{ fontFamily: "var(--serif)" }}
          >
            {slot.eventTitle}
          </h3>
          {!isHome && eventTimeLabel(slot) && (
            <span className="text-[13px] text-[var(--dim)]">{eventTimeLabel(slot)}</span>
          )}
          {researching && (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium text-[var(--dim)]">
              調査中
            </span>
          )}
        </div>
        <p className="mt-0.5 flex items-center gap-1 text-[13px] text-[var(--dim)]">
          <PinIcon className="h-3.5 w-3.5 shrink-0" />
          {slot.location || slot.area}
          {slot.area && slot.location && slot.area !== slot.location ? ` ・ ${slot.area}周辺` : ""}
          {isHome && !slot.location ? " ・ 予定のない日の定番エリア" : ""}
        </p>
      </header>

      <div className="mt-1">
        <AccordionItem
          baseId={baseId}
          slotId={slot.id}
          section="meal"
          icon={<MealIcon className="h-5 w-5" />}
          label="ランチ"
          summary={
            slot.candidates.length > 0
              ? `${slot.candidates.length}件`
              : researching
                ? "調査中"
                : "候補なし"
          }
          openKeys={openKeys}
          onToggle={onToggle}
        >
          {slot.candidates.length > 0 ? (
            <div
              data-hscroll="true"
              role="list"
              aria-label="ランチ候補（横スクロール）"
              className="flex snap-x gap-2 overflow-x-auto pb-2"
            >
              {slot.candidates.map((c) => (
                <CandidateCard
                  key={c.id}
                  candidate={c}
                  purpose="lunch"
                  rail
                  onBook={() => bookCandidate(c, "lunch")}
                  onHide={() => onHideCandidate(c)}
                  onRate={() => onRateCandidate(c)}
                  onShare={() => onShareCandidate(c)}
                />
              ))}
            </div>
          ) : (
            <p className="py-2 text-sm text-[var(--dim)]">
              食べログ3.3以上・予算内の候補を調査中です。見つかり次第ここに表示されます。
            </p>
          )}
          {slot.candidates.length > 0 && slot.candidates.length < 10 && slot.status === "ready" && (
            <p className="pt-1 text-xs text-[var(--dim)]">
              予算内（{settings.budgetYen.toLocaleString()}円以内）・食べログ3.3以上の条件に合う候補は現在{slot.candidates.length}件です。予算を超える店は表示していないため10件に届かない場合があります。次回更新で再調査します。
            </p>
          )}
          {slot.articles.length > 0 && (
            <div className="mt-2 border-t border-[var(--border)] pt-2.5">
              <p className="text-[13px] font-semibold">食べログの記事・特集</p>
              <ul className="mt-0.5">
                {slot.articles.map((a) => (
                  <li key={a.id}>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-8 items-center gap-1 py-0.5 text-[13px] font-medium text-[var(--accent)]"
                    >
                      {a.title}
                      <ExternalIcon className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </AccordionItem>

        <AccordionItem
          baseId={baseId}
          slotId={slot.id}
          section="cafe"
          icon={<CupIcon className="h-5 w-5" />}
          label="カフェ"
          summary={
            slot.cafes.length > 0
              ? `${slot.cafes.length}店舗`
              : researching
                ? "調査中"
                : "候補なし"
          }
          openKeys={openKeys}
          onToggle={onToggle}
        >
          <CafeSection slot={slot} onBookCafe={bookCafe} />
        </AccordionItem>

        {settings.sweetsEnabled && (
          <AccordionItem
            baseId={baseId}
            slotId={slot.id}
            section="sweets"
            icon={<CakeIcon className="h-5 w-5" />}
            label="お土産スイーツ"
            summary={
              slot.sweets.length > 0
                ? `${slot.sweets.length}件`
                : researching
                  ? "調査中"
                  : "候補なし"
            }
            openKeys={openKeys}
            onToggle={onToggle}
          >
            <p className="text-xs text-[var(--dim)]">
              こだわり：{settings.sweets.join("・") || "未設定"}
            </p>
            {slot.sweets.length > 0 ? (
              <div
                data-hscroll="true"
                role="list"
                aria-label="お土産スイーツ候補（横スクロール）"
                className="mt-1 flex snap-x gap-2 overflow-x-auto pb-2"
              >
                {slot.sweets.map((c) => (
                  <CandidateCard
                    key={c.id}
                    candidate={c}
                    purpose="souvenir"
                    rail
                    onBook={() => bookCandidate(c, "souvenir")}
                    onHide={() => onHideCandidate(c)}
                    onRate={() => onRateCandidate(c)}
                    onShare={() => onShareCandidate(c)}
                  />
                ))}
              </div>
            ) : (
              <p className="py-2 text-[13px] text-[var(--dim)]">
                {slot.status === "ready"
                  ? "このエリアで条件に合うお土産スイーツはまだ見つかっていません。次回更新で再調査します。"
                  : "このエリアのお土産スイーツを調査中です。"}
              </p>
            )}
          </AccordionItem>
        )}

        <AccordionItem
          baseId={baseId}
          slotId={slot.id}
          section="route"
          icon={<TrainIcon className="h-5 w-5" />}
          label="行き方"
          summary={slot.route ? routeSummary(slot.route) : "調査中"}
          openKeys={openKeys}
          onToggle={onToggle}
        >
          {slot.route ? (
            <RouteDetail route={slot.route} slot={slot} />
          ) : (
            <p className="py-2 text-[13px] text-[var(--dim)]">
              自宅最寄り駅からの行き方は調査中です。
            </p>
          )}
        </AccordionItem>
      </div>
    </section>
  );
}

/* ---------- share a shop (X / LINE / OS share sheet) ---------- */

/** What gets shared for one shop: name, area (slot area / nearest
 * station), the shop's Tabelog page URL, and — when the user has
 * rated the shop — their own score (user instruction, 2026-11-16).
 * Cafe cards are out of scope: they have no Tabelog link. */
type ShareTarget = {
  name: string;
  area: string;
  tabelogUrl: string;
  userRating: number | null;
};

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V3.5" />
      <path d="M7.8 6.8L12 2.6l4.2 4.2" />
      <path d="M5 11.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7.5" />
    </svg>
  );
}

function shopShareText(t: ShareTarget): string {
  const lines = [t.name];
  if (t.area) lines.push(t.area);
  if (t.userRating != null) lines.push(`自分の評価 ★${t.userRating.toFixed(1)}`);
  return lines.join("\n");
}

/** Small share-destination menu: X (post intent URL) and LINE (share
 * URL) are always offered; the OS share sheet (Web Share API) is
 * added where the environment supports it. */
function ShareSheet({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const text = shopShareText(target);
  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(target.tabelogUrl)}`;
  const lineUrl = `https://line.me/R/msg/text/?${encodeURIComponent(`${text}\n${target.tabelogUrl}`)}`;
  const canOsShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const osShare = async () => {
    try {
      await navigator.share({ title: target.name, text, url: target.tabelogUrl });
      onClose();
    } catch {
      // Cancelled or failed: keep the menu open so X/LINE stay usable.
    }
  };
  const linkCls =
    "flex min-h-11 items-center justify-center rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold";
  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/45 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${target.name}を共有`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[var(--surface)] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl rounded-t-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold leading-snug">共有先を選ぶ</h3>
            <p className="mt-0.5 truncate text-sm text-[var(--dim)]">{target.name}</p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg leading-none"
          >
            ×
          </button>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <a href={xUrl} target="_blank" rel="noreferrer" onClick={onClose} className={linkCls}>
            Xで共有
          </a>
          <a href={lineUrl} target="_blank" rel="noreferrer" onClick={onClose} className={linkCls}>
            LINEで共有
          </a>
          {canOsShare && (
            <button type="button" onClick={osShare} className={linkCls}>
              その他の共有（OSの共有シート）
            </button>
          )}
        </div>
        <p className="mt-4 whitespace-pre-line rounded-lg bg-[var(--bg)] px-3 py-2 text-[13px] leading-relaxed text-[var(--dim)]">
          {text}
          {"\n"}
          {target.tabelogUrl}
        </p>
      </div>
    </div>
  );
}

/* ---------- settings sheet (嗜好 / 履歴 tabs) ---------- */

function Chip({
  label,
  selected,
  onToggle,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={`min-h-9 rounded-full border px-3 text-sm ${
        selected
          ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white"
          : "border-[var(--border)] text-[var(--dim)]"
      }`}
    >
      {label}
    </button>
  );
}

/** One history card: photo thumbnail on the left (the shop's own photo
 * from its candidate card; the 写真を調査中 tile when none is stored),
 * name / own score / memo / rating date / area and the Tabelog link
 * on the right, plus a share button.
 * Swipe-to-reveal delete (user instruction, 2026-11-16; Modern Web
 * Guidance swipe-to-reveal): the card lives in a horizontal
 * scroll-snap container (.swipe-reveal in theme.css) — swiping left
 * snaps the hidden panel open and shows the 削除 button WITHOUT
 * deleting; only pressing that button deletes the shop's rating
 * (shop_feedback, the same deleteFeedback the rating sheet uses).
 * The panel button starts tabindex=-1 (off-screen at rest) and
 * becomes focusable once revealed; a visible "…" trigger button in
 * the card is the non-gesture alternative (WCAG 2.5.1) and toggles
 * the same reveal via scrollTo. Deleting here invalidates BOTH the
 * feedback history and the schedule (see HistoryPanel), so a
 * candidate card showing this shop immediately falls back to the
 * default unrated star (outline only, no score) — and vice versa,
 * deleting from the rating sheet already removed the history entry. */
function HistoryCard({
  entry,
  onShare,
  onDelete,
  isDeleting,
}: {
  entry: FeedbackEntry;
  onShare: (e: FeedbackEntry) => void;
  onDelete: (e: FeedbackEntry) => void;
  isDeleting?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const swipeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setImgFailed(false);
  }, [entry.photoUrl]);
  const showPhoto = Boolean(entry.photoUrl) && !imgFailed;
  const toggleReveal = () => {
    const el = swipeRef.current;
    if (!el) return;
    if (revealed) {
      el.scrollTo({ left: 0, behavior: "smooth" });
    } else {
      el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
    }
  };
  return (
    <li className="overflow-hidden rounded-xl">
      <div
        ref={swipeRef}
        className="swipe-reveal"
        role="group"
        aria-label={`${entry.name}の履歴カード（左スワイプで削除ボタンを表示）`}
        onScroll={(e) => setRevealed(e.currentTarget.scrollLeft > 24)}
        onFocus={(e) => {
          // Tabbing back into the card content closes the panel
          // (swipe-to-reveal guide): only for keyboard focus
          // (:focus-visible), never for pointer interaction.
          const el = swipeRef.current;
          if (!el || !revealed) return;
          const target = e.target as HTMLElement;
          const content = el.querySelector(".swipe-reveal-content");
          if (content?.contains(target) && target.matches(":focus-visible")) {
            el.scrollTo({ left: 0, behavior: "smooth" });
          }
        }}
      >
        <div className="swipe-reveal-content flex gap-3 border border-[var(--border)] bg-[var(--bg)] p-3">
          <div className="w-[104px] shrink-0 self-start overflow-hidden rounded-lg">
            {showPhoto ? (
              <img
                src={entry.photoUrl ?? undefined}
                alt={`${entry.name}の写真`}
                loading="lazy"
                onError={() => setImgFailed(true)}
                className="block aspect-[4/3] w-full object-cover"
              />
            ) : (
              <div
                aria-label="写真を調査中"
                className="flex aspect-[4/3] w-full animate-pulse flex-col items-center justify-center gap-1 bg-[var(--border)] text-[var(--dim)]"
              >
                <PhotoIcon className="h-6 w-6" />
                <span className="text-[10px] font-medium">写真を調査中</span>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 flex-1 text-sm font-semibold leading-snug">{entry.name}</p>
              <span className="shrink-0 text-sm font-bold text-[var(--accent)]">
                ★{entry.rating.toFixed(1)}
              </span>
            </div>
            <div
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
              role="img"
              aria-label={`5点満点で${entry.rating.toFixed(1)}点`}
            >
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${(entry.rating / 5) * 100}%` }}
              />
            </div>
            {entry.genre && (
              <p className="mt-1.5 text-[13px] text-[var(--dim)]">{entry.genre}</p>
            )}
            {entry.memo && <p className="mt-1 text-[13px] leading-relaxed">{entry.memo}</p>}
            <p className="mt-1 text-xs text-[var(--dim)]">
              {ratedDateLabel(entry.ratedAt)}
              {entry.area ? ` ・ ${entry.area}` : ""}
            </p>
            <div className="mt-1.5 flex items-center gap-3">
              <a
                href={entry.tabelogUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`${entry.name}を食べログで見る`}
                className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-[var(--accent)]"
              >
                <ExternalIcon className="h-3.5 w-3.5" />
                食べログで見る
              </a>
              <button
                type="button"
                onClick={() => onShare(entry)}
                aria-label={`${entry.name}を共有`}
                className="inline-flex min-h-8 items-center gap-1 text-[13px] font-medium text-[var(--accent)]"
              >
                <ShareIcon className="h-3.5 w-3.5" />
                共有
              </button>
              <button
                type="button"
                onClick={toggleReveal}
                aria-expanded={revealed}
                aria-label={`${entry.name}の削除操作を${revealed ? "閉じる" : "表示"}`}
                title="左スワイプでも削除ボタンを表示できます"
                className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--dim)]"
              >
                <DotsIcon className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
        <div
          className="swipe-reveal-panel"
          role="group"
          aria-label={`${entry.name}の操作`}
        >
          <button
            type="button"
            onClick={() => onDelete(entry)}
            disabled={isDeleting}
            tabIndex={revealed ? 0 : -1}
            aria-label={`${entry.name}の評価を削除`}
            className="flex w-full flex-col items-center justify-center gap-1 bg-[#c92a2a] px-2 text-sm font-bold text-white disabled:opacity-60 dark:bg-[#a61e1e]"
          >
            <TrashIcon className="h-5 w-5" />
            {isDeleting ? "削除中…" : "削除"}
          </button>
        </div>
      </div>
    </li>
  );
}

function csvCell(v: string): string {
  return `"${v.replaceAll('"', '""')}"`;
}

/** Downloads the FULL history (never the filtered subset) as
 * 過去履歴.csv — the file name the user specified. A UTF-8 BOM is
 * prepended so spreadsheet apps open the Japanese text correctly. */
function downloadHistoryCsv(entries: FeedbackEntry[]) {
  const header = ["店名", "自分の点数", "メモ", "評価日", "エリア", "ジャンル", "食べログURL"];
  const lines = entries.map((e) =>
    [
      e.name,
      e.rating.toFixed(1),
      e.memo,
      ratedDateLabel(e.ratedAt),
      e.area,
      e.genre,
      e.tabelogUrl,
    ]
      .map(csvCell)
      .join(","),
  );
  const csv = "\uFEFF" + [header.map(csvCell).join(","), ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "過去履歴.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type HistorySort = "new" | "rating-desc" | "rating-asc";

/** The 履歴 tab: the user's own rating history as photo cards, with
 * keyword search (name / area / genre / memo — the "あの店なんだっけ？"
 * lookup), rating sort (asc/desc) or newest first, and a CSV export
 * of the full history. Each card is swipe-to-reveal deletable (see
 * HistoryCard): deleting removes the shop's shop_feedback row via
 * the SAME deleteFeedback action the rating sheet uses, and the
 * deletion is synced to the candidate cards — the optimistic cache
 * update below clears that shop's userRating/userMemo in the cached
 * schedule at once (its star button falls back to the default
 * unrated outline, no score), and onSettled invalidates BOTH the
 * feedback and schedule queries so the history count/average and
 * every candidate card re-read the one shared per-shop rating
 * state from the server. The reverse direction already holds:
 * FeedbackSheet's delete invalidates the same two queries, so a
 * rating deleted there disappears from this history too. */
function HistoryPanel({
  entries,
  onShare,
}: {
  entries: FeedbackEntry[];
  onShare: (e: FeedbackEntry) => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<HistorySort>("new");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const searchId = useId();
  const sortId = useId();
  type FeedbackData = ApiResponse<typeof api, "getFeedback">;
  const deleteFeedback = useMutation({
    mutationFn: async (entry: FeedbackEntry) =>
      await api.deleteFeedback({ tabelogUrl: entry.tabelogUrl }),
    onMutate: async (entry) => {
      setDeleteError(null);
      await queryClient.cancelQueries({ queryKey: ["feedback"] });
      await queryClient.cancelQueries({ queryKey: ["schedule"] });
      const prevFeedback =
        queryClient.getQueryData<FeedbackData>(["feedback"]);
      const prevSchedule = queryClient.getQueryData<Schedule>(["schedule"]);
      // Optimistic: drop the history entry (count/average derive from
      // it, so they recalculate immediately)…
      queryClient.setQueryData<FeedbackData>(["feedback"], (old) =>
        old
          ? {
              ...old,
              entries: old.entries.filter((e) => e.id !== entry.id),
            }
          : old,
      );
      // …and reset the same shop's candidate cards to unrated, so
      // the star button is back to default before the refetch lands.
      // Shop identity is the Tabelog URL key ONLY (the supplement's
      // one-store-one-row rule): match on the restaurant id embedded
      // in the URL (a 7+ digit path segment — candidate URLs may
      // carry a /dtlrvwlst/… suffix the stored rating URL lacks),
      // falling back to exact URL equality when neither URL carries
      // an id. NEVER match on shop name: a same-named different
      // branch is a different shop with its own rating row, and its
      // star must not reset.
      const tabelogId = (url: string | null): string | null =>
        url?.split("/").find((p) => /^\d{7,}$/.test(p)) ?? null;
      const entryId = tabelogId(entry.tabelogUrl);
      const isSameShopByUrl = (url: string | null): boolean => {
        const id = tabelogId(url);
        if (entryId && id) return id === entryId;
        return url != null && url === entry.tabelogUrl;
      };
      queryClient.setQueryData<Schedule>(["schedule"], (old) =>
        old
          ? {
              ...old,
              weeks: old.weeks.map((w) => ({
                ...w,
                days: w.days.map((d) => ({
                  ...d,
                  slots: d.slots.map((s) => ({
                    ...s,
                    candidates: s.candidates.map((c) =>
                      isSameShopByUrl(c.tabelogUrl)
                        ? { ...c, userRating: null, userMemo: null }
                        : c,
                    ),
                    sweets: s.sweets.map((c) =>
                      isSameShopByUrl(c.tabelogUrl)
                        ? { ...c, userRating: null, userMemo: null }
                        : c,
                    ),
                  })),
                })),
              })),
            }
          : old,
      );
      return { prevFeedback, prevSchedule };
    },
    onError: (_err, _entry, context) => {
      if (context?.prevFeedback) {
        queryClient.setQueryData(["feedback"], context.prevFeedback);
      }
      if (context?.prevSchedule) {
        queryClient.setQueryData(["schedule"], context.prevSchedule);
      }
      setDeleteError("削除できませんでした。少し待って再度お試しください。");
    },
    onSettled: () => {
      // Re-read the shared per-shop rating state: history (count /
      // average included) and candidate cards stay in agreement.
      queryClient.invalidateQueries({ queryKey: ["feedback"] });
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
    },
  });
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = entries.filter((e) => {
    if (!tokens.length) return true;
    const hay = `${e.name} ${e.area} ${e.genre} ${e.memo}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "rating-desc") return b.rating - a.rating || b.ratedAt.localeCompare(a.ratedAt);
    if (sort === "rating-asc") return a.rating - b.rating || b.ratedAt.localeCompare(a.ratedAt);
    return b.ratedAt.localeCompare(a.ratedAt);
  });
  return (
    <div>
      {entries.length > 0 ? (
        <>
          <p className="text-xs text-[var(--dim)]">
            {entries.length}件 ・ 平均{" "}
            {(entries.reduce((sum, e) => sum + e.rating, 0) / entries.length).toFixed(1)}点
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <div>
              <label htmlFor={searchId} className="sr-only">
                履歴を検索（店名・場所・種類・メモ）
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="店名・場所・うどん等の種類・メモで検索"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={sortId} className="sr-only">
                  並び替え
                </label>
                <select
                  id={sortId}
                  value={sort}
                  onChange={(e) => setSort(e.target.value as HistorySort)}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm"
                >
                  <option value="new">新しい順</option>
                  <option value="rating-desc">点数が高い順</option>
                  <option value="rating-asc">点数が低い順</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => downloadHistoryCsv(entries)}
                aria-label="履歴全件をCSVで書き出す（過去履歴.csv）"
                className="min-h-10 shrink-0 rounded-lg border border-[var(--border)] px-3 text-sm font-medium"
              >
                CSVで書き出す
              </button>
            </div>
          </div>
          {tokens.length > 0 && (
            <p className="mt-2 text-xs text-[var(--dim)]">{sorted.length}件がヒットしました</p>
          )}
          {deleteError && (
            <p className="mt-3 text-sm text-[#c92a2a] dark:text-[#ff8787]">{deleteError}</p>
          )}
          {sorted.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2">
              {sorted.map((e) => (
                <HistoryCard
                  key={e.id}
                  entry={e}
                  onShare={onShare}
                  onDelete={(entry) => deleteFeedback.mutate(entry)}
                  isDeleting={
                    deleteFeedback.isPending &&
                    deleteFeedback.variables?.id === e.id
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-[var(--dim)]">
              条件に合う店がありません。検索語を変えてみてください。
            </p>
          )}
        </>
      ) : (
        <p className="text-[13px] text-[var(--dim)]">
          まだ評価した店はありません。候補カードの星ボタンから評価すると、ここに履歴が残ります。
        </p>
      )}
    </div>
  );
}

function SettingsSheet({
  initial,
  genreOptions,
  sweetOptions,
  hiddenShops,
  feedbackEntries,
  onUnhide,
  onShare,
  onClose,
  onSaved,
}: {
  initial: FoodSettings;
  genreOptions: string[];
  sweetOptions: string[];
  hiddenShops: HiddenShop[];
  feedbackEntries: FeedbackEntry[];
  onUnhide: (shop: HiddenShop) => void;
  onShare: (e: FeedbackEntry) => void;
  onClose: () => void;
  onSaved: (refreshStarted: boolean) => void;
}) {
  const [genres, setGenres] = useState<string[]>(initial.genres);
  const [budgetYen, setBudgetYen] = useState<number>(initial.budgetYen);
  const [sweetsEnabled, setSweetsEnabled] = useState(initial.sweetsEnabled);
  const [sweets, setSweets] = useState<string[]>(initial.sweets);
  const [error, setError] = useState<string | null>(null);
  // Settings tabs (user instruction, 2026-11-16): 嗜好 (preferences)
  // and 履歴 (rating history) are separate contents, switched with a
  // tab UI following the Modern Web Guidance tabs pattern —
  // role=tablist/tab/tabpanel, aria-selected drives the underline,
  // selection follows focus, arrow keys move between tabs.
  const [tab, setTab] = useState<"prefs" | "history">("prefs");
  const prefsTabId = useId();
  const historyTabId = useId();
  const prefsPanelId = useId();
  const historyPanelId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabKeys = ["prefs", "history"] as const;
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = tabKeys.indexOf(tab);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (current + 1) % tabKeys.length;
    else if (e.key === "ArrowLeft") next = (current - 1 + tabKeys.length) % tabKeys.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabKeys.length - 1;
    if (next == null) return;
    e.preventDefault();
    const key = tabKeys[next];
    if (!key) return;
    setTab(key);
    tabRefs.current[next]?.focus();
  };

  const save = useMutation({
    mutationFn: async () =>
      await api.updateSettings({ genres, budgetYen, sweetsEnabled, sweets }),
    onSuccess: (r) => onSaved(r.refreshStarted),
    onError: () => setError("保存できませんでした。少し待って再度お試しください。"),
  });

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) =>
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const tabCls = "settings-tab min-h-11 flex-1 px-4 text-[15px]";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="設定"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-md overflow-y-auto bg-[var(--surface)] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl rounded-t-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold leading-snug">設定</h3>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div
          role="tablist"
          aria-label="設定の種類"
          onKeyDown={onTabKeyDown}
          className="mt-3 flex border-b border-[var(--border)]"
        >
          <button
            type="button"
            role="tab"
            id={prefsTabId}
            aria-selected={tab === "prefs"}
            aria-controls={prefsPanelId}
            tabIndex={tab === "prefs" ? 0 : -1}
            ref={(el) => {
              tabRefs.current[0] = el;
            }}
            onClick={() => setTab("prefs")}
            className={tabCls}
          >
            嗜好
          </button>
          <button
            type="button"
            role="tab"
            id={historyTabId}
            aria-selected={tab === "history"}
            aria-controls={historyPanelId}
            tabIndex={tab === "history" ? 0 : -1}
            ref={(el) => {
              tabRefs.current[1] = el;
            }}
            onClick={() => setTab("history")}
            className={tabCls}
          >
            履歴
          </button>
        </div>

        {tab === "prefs" ? (
          <div role="tabpanel" id={prefsPanelId} aria-labelledby={prefsTabId}>
            <div className="mt-5">
              <p className="text-sm font-semibold">好みのジャンル</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {genreOptions.map((g) => (
                  <Chip
                    key={g}
                    label={g}
                    selected={genres.includes(g)}
                    onToggle={() => toggle(genres, setGenres, g)}
                  />
                ))}
              </div>
            </div>

            <div className="mt-5">
              <label className="text-sm font-semibold" htmlFor="budget-select">
                ランチ予算（上限）
              </label>
              <select
                id="budget-select"
                value={budgetYen}
                onChange={(e) => setBudgetYen(Number(e.target.value))}
                className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm"
              >
                <option value={1500}>1,500円以内</option>
                <option value={2000}>2,000円以内</option>
                <option value={2500}>2,500円以内</option>
                <option value={3000}>3,000円以内</option>
              </select>
              <p className="mt-1 text-xs text-[var(--dim)]">
                予算を超える店は候補に入れません（予算内の店だけで補充します）。予算内で10件に届かない場合は、不足したまま表示します。
              </p>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">お土産スイーツの候補も出す</p>
                <button
                  type="button"
                  role="switch"
                  aria-checked={sweetsEnabled}
                  aria-label="お土産スイーツの候補を表示"
                  onClick={() => setSweetsEnabled(!sweetsEnabled)}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
                    sweetsEnabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${
                      sweetsEnabled ? "left-[1.375rem]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
              {sweetsEnabled && (
                <>
                  <p className="mt-3 text-sm font-semibold">お土産のこだわり</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {sweetOptions.map((s) => (
                      <Chip
                        key={s}
                        label={s}
                        selected={sweets.includes(s)}
                        onToggle={() => toggle(sweets, setSweets, s)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="mt-5">
              <p className="text-sm font-semibold">除外リスト（非表示にした店）</p>
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                候補カード左下の「！」ボタンで非表示にした店です。今後の候補には二度と出ません。「戻す」と次回以降の更新で再び候補になることがあります。
              </p>
              {hiddenShops.length > 0 ? (
                <ul className="mt-2 divide-y divide-[var(--border)]">
                  {hiddenShops.map((shop) => (
                    <li key={shop.id} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0 flex-1 truncate text-sm">{shop.name}</span>
                      <button
                        type="button"
                        onClick={() => onUnhide(shop)}
                        aria-label={`${shop.name}を除外リストから戻す`}
                        className="min-h-9 shrink-0 rounded-full border border-[var(--border)] px-3 text-[13px] font-medium"
                      >
                        戻す
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[13px] text-[var(--dim)]">まだありません。</p>
              )}
            </div>

            {error && <p className="mt-4 text-sm text-[#c92a2a] dark:text-[#ff8787]">{error}</p>}

            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="mt-6 min-h-11 w-full rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {save.isPending ? "保存中…" : "保存して候補を再調査"}
            </button>
          </div>
        ) : (
          <div role="tabpanel" id={historyPanelId} aria-labelledby={historyTabId} className="mt-4">
            <HistoryPanel entries={feedbackEntries} onShare={onShare} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- app ---------- */

export function App() {
  const queryClient = useQueryClient();
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<FeedbackTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // Non-exclusive accordion state: a set of open section keys,
  // "<weekIdx>|<date>|<slotId>:<section>". Each section toggles
  // independently (user instruction, 2026-11-16); all start closed.
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  const [activeWeek, setActiveWeek] = useState(0);
  // Horizontal swipe on the day-list region switches weeks. Swipes that
  // start on a candidate card belong to the card's delete gesture, so only
  // swipes starting elsewhere (headings, margins, empty space) count.
  const weekTouchRef = useRef<{ x: number; y: number; onCard: boolean } | null>(null);

  const schedule = useQuery({
    queryKey: ["schedule"],
    queryFn: () => api.getSchedule({}),
    refetchInterval: (q) => (q.state.data?.anyResearching ? 30_000 : false),
  });

  const settingsMeta = useQuery({
    queryKey: ["settings-options"],
    queryFn: () => api.getSettings({}),
    enabled: settingsOpen,
  });

  const hiddenShops = useQuery({
    queryKey: ["hidden-shops"],
    queryFn: () => api.getHiddenShops({}),
    enabled: settingsOpen,
  });

  const feedbackHistory = useQuery({
    queryKey: ["feedback"],
    queryFn: () => api.getFeedback({}),
    enabled: settingsOpen,
  });

  // Hide via the card's circled-! button: remove the card from the cached
  // schedule immediately, then let the server record the shop on the
  // permanent exclusion list (it also removes the same shop from every
  // other slot).
  const hideCandidate = useMutation({
    mutationFn: async (c: Candidate) => await api.hideCandidate({ candidateId: c.id }),
    onMutate: async (c) => {
      await queryClient.cancelQueries({ queryKey: ["schedule"] });
      queryClient.setQueryData<Schedule>(["schedule"], (old) =>
        old
          ? {
              ...old,
              weeks: old.weeks.map((w) => ({
                ...w,
                days: w.days.map((d) => ({
                  ...d,
                  slots: d.slots.map((s) => ({
                    ...s,
                    candidates: s.candidates.filter((x) => x.id !== c.id),
                    sweets: s.sweets.filter((x) => x.id !== c.id),
                  })),
                })),
              })),
            }
          : old,
      );
    },
    onSuccess: (_r, c) =>
      setRefreshNote(`「${c.name}」を非表示にしました。この店は今後どの枠にも表示されません。不足分は次回の更新で予算内の別の店が補充されます。`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      queryClient.invalidateQueries({ queryKey: ["hidden-shops"] });
    },
  });

  const unhideShop = useMutation({
    mutationFn: async (shop: HiddenShop) => await api.unhideShop({ id: shop.id }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["hidden-shops"] }),
  });

  const refresh = useMutation({
    mutationFn: async () => await api.refreshSchedule({}),
    onSuccess: (r) => {
      setRefreshNote(
        r.started
          ? "カレンダーと食べログの再調査を開始しました。数分後に自動で反映されます。"
          : "調査はすでに進行中です。完了次第ここに反映されます。",
      );
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
    },
    onError: () => setRefreshNote("更新を開始できませんでした。少し待って再度お試しください。"),
  });

  const data = schedule.data;

  const weekCount = data?.weeks.length ?? 0;
  const weekIndex = weekCount > 0 ? Math.min(activeWeek, weekCount - 1) : 0;

  const switchWeek = (idx: number) => {
    if (idx < 0 || idx >= weekCount || idx === weekIndex) return;
    setActiveWeek(idx);
    setOpenKeys(new Set());
    window.scrollTo({ top: 0 });
  };

  const onWeekTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    const t = e.touches[0];
    if (!t) return;
    const target = e.target as HTMLElement;
    weekTouchRef.current = {
      x: t.clientX,
      y: t.clientY,
      // Swipes starting inside a horizontal rail (lunch candidates, cafe
      // shops) belong to the rail, not to the week switch.
      onCard: target.closest("[data-hscroll]") != null,
    };
  };
  const onWeekTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const start = weekTouchRef.current;
    weekTouchRef.current = null;
    if (!start || start.onCard) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) >= 64 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      switchWeek(weekIndex + (dx < 0 ? 1 : -1));
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-10">
        {/* Header row (user instructions, 2026-11-15 + 2026-11-16):
            ONE single line holding the week tabs AND the settings /
            refresh controls — compact, never wrapping to two lines,
            and no subtitle / last-updated / other meta text. */}
        <div className="flex flex-nowrap items-center gap-2 pb-3 pt-4">
          {data && data.weeks.length > 1 && (
            <nav aria-label="週の移動" className="flex min-w-0 items-center gap-1.5">
              {data.weeks.map((w, i) => (
                <button
                  key={w.label}
                  type="button"
                  aria-current={i === weekIndex ? "true" : undefined}
                  onClick={() => switchWeek(i)}
                  className={`flex min-h-9 shrink-0 items-center rounded-full border px-2.5 text-xs ${
                    i === weekIndex
                      ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white"
                      : "border-[var(--border)] bg-[var(--surface)] font-medium"
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </nav>
          )}
          <div className="ml-auto flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="好みの設定を開く"
              className="flex min-h-9 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium"
            >
              <GearIcon className="h-4 w-4" />
              設定
            </button>
            <button
              type="button"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              aria-label="カレンダーと候補を更新"
              className="flex min-h-9 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] font-medium disabled:opacity-50"
            >
              <RefreshIcon className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
              更新
            </button>
          </div>
        </div>
        {refreshNote && (
          <p className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--dim)]">
            {refreshNote}
          </p>
        )}

        {schedule.isPending && (
          <p className="py-16 text-center text-sm text-[var(--dim)]">読み込んでいます…</p>
        )}
        {schedule.isError && (
          <div className="py-16 text-center">
            <p className="text-sm text-[var(--dim)]">読み込みに失敗しました。</p>
            <button
              type="button"
              onClick={() => schedule.refetch()}
              className="mt-3 min-h-10 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium"
            >
              再読み込み
            </button>
          </div>
        )}

        {data && data.weeks[weekIndex] && (
          <div onTouchStart={onWeekTouchStart} onTouchEnd={onWeekTouchEnd}>
            {(() => {
              const week = data.weeks[weekIndex]!;
              return (
                <section key={week.label} className="mb-8">
                  <h2
                    className="mb-3 text-xl font-bold"
                    style={{ fontFamily: "var(--serif)" }}
                  >
                    {week.label}
                  </h2>
                  <div className="flex flex-col gap-5">
                    {week.days.map((day) => {
                      const { md, wd } = dayLabel(day.date);
                      const dayPrefix = `${weekIndex}|${day.date}|`;
                      return (
                        <div key={day.date}>
                          <h3 className="mb-2 flex items-baseline gap-2">
                            <span
                              className="text-[17px] font-semibold"
                              style={{ fontFamily: "var(--serif)" }}
                            >
                              {md}（{wd}）
                            </span>
                            {day.isToday && (
                              <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-semibold text-white">
                                今日
                              </span>
                            )}
                          </h3>
                          <div className="flex flex-col gap-3">
                            {day.slots.map((slot) => (
                              <SlotBlock
                                key={`${day.date}-${slot.id}-${slot.eventTitle}`}
                                slot={slot}
                                date={day.date}
                                settings={data.settings}
                                baseId={`acc-${weekIndex}`}
                                openKeys={
                                  new Set(
                                    [...openKeys]
                                      .filter((k) => k.startsWith(dayPrefix))
                                      .map((k) => k.slice(dayPrefix.length)),
                                  )
                                }
                                onToggle={(k) =>
                                  setOpenKeys((prev) => {
                                    const full = dayPrefix + k;
                                    const next = new Set(prev);
                                    if (next.has(full)) {
                                      next.delete(full);
                                    } else {
                                      next.add(full);
                                    }
                                    return next;
                                  })
                                }
                                onBook={setSheet}
                                onHideCandidate={(c) => hideCandidate.mutate(c)}
                                onRateCandidate={(c) =>
                                  setFeedbackTarget({ candidate: c, area: slot.area })
                                }
                                onShareCandidate={(c) => {
                                  if (!c.tabelogUrl) return;
                                  setShareTarget({
                                    name: c.name,
                                    area: slot.area,
                                    tabelogUrl: c.tabelogUrl,
                                    userRating: c.userRating,
                                  });
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })()}
          </div>
        )}

      </main>

      {sheet && <BookingSheet target={sheet} onClose={() => setSheet(null)} />}
      {feedbackTarget && (
        <FeedbackSheet
          key={feedbackTarget.candidate.id}
          target={feedbackTarget}
          onClose={() => setFeedbackTarget(null)}
        />
      )}
      {shareTarget && (
        <ShareSheet target={shareTarget} onClose={() => setShareTarget(null)} />
      )}
      {settingsOpen && data && (
        <SettingsSheet
          initial={data.settings}
          genreOptions={settingsMeta.data?.genreOptions ?? data.settings.genres}
          sweetOptions={settingsMeta.data?.sweetOptions ?? data.settings.sweets}
          hiddenShops={hiddenShops.data?.shops ?? []}
          feedbackEntries={feedbackHistory.data?.entries ?? []}
          onUnhide={(shop) => unhideShop.mutate(shop)}
          onShare={(e) =>
            setShareTarget({
              name: e.name,
              area: e.area,
              tabelogUrl: e.tabelogUrl,
              userRating: e.rating,
            })
          }
          onClose={() => setSettingsOpen(false)}
          onSaved={(refreshStarted) => {
            setSettingsOpen(false);
            setRefreshNote(
              refreshStarted
                ? "設定を保存しました。新しい好みで候補の再調査を開始しました。"
                : "設定を保存しました。調査が進行中のため、完了後の次回更新から新しい好みが反映されます。",
            );
            queryClient.invalidateQueries({ queryKey: ["schedule"] });
          }}
        />
      )}
    </div>
  );
}
