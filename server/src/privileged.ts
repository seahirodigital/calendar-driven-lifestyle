// Privileged host handlers for 予定日程付近グルメ.
//
// `readPrimaryCalendarEvents` powers the 5-minute calendar watch
// (user instruction, 2026-11-17): the watch must be CHEAP — a
// fingerprint comparison only, using no agent and no model tokens when
// nothing changed. Server actions cannot run subprocesses, so the
// actual calendar read happens here on the host: it invokes the
// google_calendar connector CLI (/opt/hatch/bin/hatch_gws_cli), lists
// ONLY the user's own primary calendar (the one flagged primary with
// accessRole owner; shared calendars and holiday calendars are
// never touched), and returns
// just the fingerprint fields of each event in the window
// (id / title / start / end / allDay / location / status). The calling
// action compares those fingerprints with the ones stored from the
// previous check and starts the heavy batch research ONLY for slots
// whose event is new or changed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  definePrivilegedContracts,
  definePrivilegedHandlers,
  z,
} from "@hatch/space-sdk";

const execFileAsync = promisify(execFile);

const GWS_CLI = "/opt/hatch/bin/hatch_gws_cli";

export const privileged = definePrivilegedContracts({
  readPrimaryCalendarEvents: {
    request: z.object({
      timeMin: z.string().min(1),
      timeMax: z.string().min(1),
    }),
    response: z.object({
      ok: z.boolean(),
      // Human-readable failure note when ok is false (CLI missing, not
      // connected, unparseable output…). The watch treats a failed read
      // as "no information" and simply retries on the next tick.
      error: z.string(),
      events: z.array(
        z.object({
          id: z.string(),
          summary: z.string(),
          // Timed events: the start/end dateTime exactly as the API
          // returns it (offset included). All-day events: the
          // YYYY-MM-DD date.
          start: z.string(),
          end: z.string(),
          allDay: z.boolean(),
          location: z.string(),
          status: z.string(),
        }),
      ),
    }),
    capabilities: ["subprocess.exec"],
    timeoutMs: 90000,
  },
});

type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  status: string;
};

type RawCalendarList = {
  items?: {
    id?: string;
    primary?: boolean;
    accessRole?: string;
  }[];
};

type RawEvent = {
  id?: string;
  summary?: string;
  status?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

type RawEventList = {
  items?: RawEvent[];
  nextPageToken?: string;
};

async function runGws(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(GWS_CLI, args, {
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async readPrimaryCalendarEvents(args) {
    try {
      const list = (await runGws([
        "calendar",
        "calendarList",
        "list",
        "--format",
        "json",
      ])) as RawCalendarList;
      const items = list.items ?? [];
      // The user's OWN primary calendar only: flagged primary and owned
      // by the user. Shared calendars (family, holidays) are
      // reader-only and never primary, so they can never be selected.
      const primary =
        items.find((c) => c.primary === true && c.accessRole === "owner") ??
        items.find((c) => c.primary === true);
      if (!primary?.id) {
        return { ok: false, error: "primary calendar not found", events: [] };
      }
      const events: CalendarEvent[] = [];
      let pageToken: string | undefined;
      // The window is ~3 weeks; a handful of pages is more than enough.
      for (let page = 0; page < 6; page++) {
        const params: Record<string, unknown> = {
          calendarId: primary.id,
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 250,
        };
        if (pageToken) params.pageToken = pageToken;
        const res = (await runGws([
          "calendar",
          "events",
          "list",
          "--params",
          JSON.stringify(params),
          "--format",
          "json",
        ])) as RawEventList;
        for (const ev of res.items ?? []) {
          if (!ev.id) continue;
          const start = ev.start?.dateTime ?? ev.start?.date ?? "";
          const end = ev.end?.dateTime ?? ev.end?.date ?? "";
          events.push({
            id: ev.id,
            summary: ev.summary ?? "",
            start,
            end,
            allDay: ev.start?.date != null,
            location: ev.location ?? "",
            status: ev.status ?? "",
          });
        }
        pageToken = res.nextPageToken;
        if (!pageToken) break;
      }
      return { ok: true, error: "", events };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 300) : "unknown error",
        events: [],
      };
    }
  },
});
