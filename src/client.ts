/**
 * Holdsport API client — the data + business logic shared by the CLI and the
 * MCP server.
 *
 * Two backends live behind one client:
 *  - The REST API (https://api.holdsport.dk/v1) over HTTP Basic auth, for
 *    teams/members/roster/etc. (the private `get` and the methods built on it).
 *  - The GraphQL API (https://www.holdsport.dk/graphql) for chat, email, and
 *    activities, which REST doesn't expose. It needs the `X-App-Version` header
 *    to answer at all, a `SignIn` mutation to mint an access token, and that
 *    token echoed back in a raw `Authorization` header — all reverse-engineered
 *    from the mobile app.
 *
 * Everything is read-only except two deliberate write paths: `createActivity`
 * and `updateActivity` (GraphQL `ChangeCurrentTeam` + `CreateActivity` /
 * `UpdateActivity`, with the team switch verified before writing). There is
 * still no raw-request escape hatch.
 *
 * Nothing in here writes to the terminal or calls process.exit: methods return
 * plain JS data and throw `Error` on failure, so each front-end decides how to
 * surface results and errors (the CLI prints + exits; the MCP server maps throws
 * to tool errors).
 *
 * API docs: https://github.com/Holdsport/holdsport-api
 */

export const DEFAULT_BASE_URL = "https://api.holdsport.dk/v1";
export const DEFAULT_GRAPHQL_URL = "https://www.holdsport.dk/graphql";

/**
 * The GraphQL endpoint silently returns an empty `{}` for every request unless
 * it sees an `X-App-Version` header (any non-empty value works). This is the
 * value the v8 app sends.
 */
const APP_VERSION = "8.0.199";

export interface Config {
  /**
   * Holdsport login username, used for both REST (Basic auth) and GraphQL
   * (chat/email `SignIn`). It must be the *login username* — not the email and
   * not the member number — because chat only accepts that form (REST accepts
   * any of the three).
   */
  username: string;
  password: string;
  /** Default team for team-scoped calls when no explicit id is given. */
  teamId?: string;
}

export type Query = Record<string, string | number | undefined>;

/**
 * Build a Config from explicit overrides, falling back to environment variables
 * for any field not supplied. Throws if username/password can't be resolved.
 *
 * The CLI calls this with no arguments (pure env). The MCP server passes the
 * credentials it parsed from its command-line flags as overrides.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const username = overrides.username ?? process.env.HOLDSPORT_USERNAME;
  const password = overrides.password ?? process.env.HOLDSPORT_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Missing credentials. Provide a username and password " +
        "(CLI: HOLDSPORT_USERNAME / HOLDSPORT_PASSWORD; MCP: --username / --password).",
    );
  }

  return {
    username,
    password,
    teamId: overrides.teamId ?? process.env.HOLDSPORT_TEAM_ID,
  };
}

interface MemberRecord {
  id?: number;
  firstname?: string;
  lastname?: string;
  role?: number;
  birthday?: string;
  member_number?: string;
  addresses?: Array<{ mobile?: string; email?: string }>;
}

export interface RosterEntry {
  name: string;
  role: string;
  birthday: string;
  mobile: string;
  email: string;
  member_number: string;
}

/** A chat room as shown in the room list, shaped for humans. */
export interface ChatRoomSummary {
  id: number;
  name: string;
  /** `rooms_users` (ad-hoc), `team`, `activity`, … */
  scope: string;
  unread_count: number;
  /** The most recent message's author, text, and ISO timestamp, if any. */
  last_message: { author: string; text: string; time: string } | null;
  /** The activity a room is attached to, for activity-scoped rooms. */
  activity: { id: number; name: string } | null;
}

/** A single chat message, shaped for humans. */
export interface ChatMessage {
  id: number;
  /** ISO-8601 timestamp. */
  time: string;
  author: string;
  text: string;
  /** Attached image/file URLs, if any. */
  images: string[];
}

/** A chat room with its messages, oldest first. */
export interface ChatRoomDetail {
  id: number;
  name: string;
  scope: string;
  unread_count: number;
  messages: ChatMessage[];
}

/** An email as shown in an inbox/sent list, shaped for humans. */
export interface EmailSummary {
  id: number;
  subject: string;
  sender: string;
  /** ISO-8601 timestamp. */
  time: string;
  has_been_read: boolean;
  has_attachments: boolean;
}

export interface EmailAttachment {
  name: string;
  url: string;
}

/** A single email with its body and attachments. */
export interface EmailDetail {
  id: number;
  subject: string;
  sender: string;
  /** Recipient names (these blasts can have hundreds). */
  recipients: string[];
  time: string;
  has_been_read: boolean;
  /** Body; may contain HTML. */
  content: string;
  attachments: EmailAttachment[];
}

// --- Activities (GraphQL) --------------------------------------------------
// Activities/attendance run over GraphQL: the list carries a live sign-up count
// per activity, and the detail returns the full attendance breakdown by name.

/** Today's date as `YYYY-MM-DD` in the machine's local timezone. Using local
 * rather than UTC keeps "today" aligned with the wall clock — a UTC date can sit
 * a day off near midnight, which would drop or add a day's activities. */
function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** An activity as shown in the list, shaped for humans. */
export interface ActivitySummary {
  id: number;
  name: string;
  /** ISO-8601 start timestamp. */
  time: string;
  /** ISO-8601 end timestamp. */
  end_time: string;
  place: string;
  /** Meeting time (Mødetid), team-local `HH:MM`; empty when not set. */
  meeting_time: string;
  event_type: string;
  is_cancelled: boolean;
  /** How many have signed up (players + coaches). */
  attendee_count: number;
  /**
   * Places available, or `null` when the activity is uncapped.
   *
   * Holdsport stores "no limit" as the sentinel 999 rather than as an absent
   * value, so that is normalised away here — reporting "50 of 999" would be
   * noise on every ordinary training session.
   */
  max_attendees?: number | null;
  /** Whether a full activity puts further sign-ups on a waiting list. */
  has_waiting_list?: boolean;
  /**
   * When sign-up closes, ISO-8601; `""` when there is no deadline set.
   *
   * The reason behind "Tilmeldingsfristen er overskredet" in the app. REST
   * does not expose it at all — it only reports an empty `actions` array — so
   * without this a closed activity can be detected but never explained.
   */
  registration_deadline?: string;
  /**
   * The teams whose calendar this activity sits on. Usually one; a session two
   * squads share carries both. Kept as id + name rather than a joined string so
   * a caller can tell *its own* team apart from the others it is shared with —
   * by id, since a configured team name need not match the server's spelling.
   *
   * Optional so that adding it does not break anyone constructing an
   * `ActivitySummary` by hand; `toActivitySummary` always populates it.
   */
  teams?: Array<{ id: number; name: string }>;
}

/** An event type a team's activities can be filed under. */
export interface EventType {
  id: number;
  name: string;
  color: string;
}

/**
 * Registration types (Tilmeldingstype) — how sign-up works for an activity —
 * name → the API's int code. The codes come from the GraphQL schema itself:
 * the description on `Activity.type` lists them, and the mutations'
 * `activity_type` input field takes the same codes (it is the NOT NULL column
 * behind the mandatory echo in {@link ActivityForEdit.passthrough}).
 */
export const REGISTRATION_TYPES = {
  /** Members sign up themselves — the server's default for new activities. */
  normal: 0,
  /** The coach picks the squad (Udtagelse). */
  pick_out: 1,
  /** Members mark themselves available; the coach confirms. */
  available: 2,
  /** Everybody is signed up by default and opts out instead. */
  everybody_attending: 3,
  pick_out_sub_teams: 4,
  /** No sign-up at all. */
  no_registration: 5,
} as const;

export type RegistrationType = keyof typeof REGISTRATION_TYPES;

/** The name for an API registration-type code; undefined for unknown codes. */
export function registrationTypeName(
  code: number,
): RegistrationType | undefined {
  return (Object.keys(REGISTRATION_TYPES) as RegistrationType[]).find(
    (name) => REGISTRATION_TYPES[name] === code,
  );
}

/**
 * Fields for a new activity. Dates are `YYYY-MM-DD`; times are `HH:MM`
 * (24-hour), interpreted by the server in the team's local timezone.
 */
export interface NewActivity {
  name: string;
  /** Start date, `YYYY-MM-DD`. */
  date: string;
  /** Start time, `HH:MM` (24-hour). */
  start_time: string;
  end_time?: string;
  /** End date for multi-day activities; the server defaults to the start date. */
  end_date?: string;
  /** Meeting time (Mødetid), `HH:MM` — the API's `pickup_time`. */
  meeting_time?: string;
  /** See {@link HoldsportClient.listEventTypes} for the valid ids. */
  event_type_id?: number;
  place?: string;
  comment?: string;
  max_attendees?: number;
  /** Sign-up mode (Tilmeldingstype); see {@link REGISTRATION_TYPES}. */
  registration_type?: RegistrationType;
}

/**
 * An activity's current editable fields (converted to team-local wall clock)
 * plus the context an edit needs: the owning team and the repeat flag.
 */
export interface ActivityForEdit {
  id: number;
  team: { id: number; name: string } | null;
  /** Part of a repeating series — edits need an explicit repeat scope. */
  is_repeated: boolean;
  /** Payment activity — {@link HoldsportClient.updateActivity} refuses these. */
  is_payment: boolean;
  fields: NewActivity;
  /**
   * Current values of the server-assigned fields *outside* {@link NewActivity},
   * keyed by mutation input name. `UpdateActivity` NULLs every column whose
   * input field is omitted (verified the hard way: an update without
   * `activity_type` died on the column's NOT NULL constraint), so these must be
   * echoed back verbatim on every update. Fields that are currently null are
   * left out — omitting them re-assigns NULL, a no-op.
   */
  passthrough: Record<string, unknown>;
}

// The API returns instants in UTC, but `CreateActivityInput`/`UpdateActivityInput`
// want wall-clock date + time strings, which the server reads in the team's
// timezone. The club runs on Danish time (same hardcoding, with the same
// rationale, as src/render.ts), so editable fields convert through this zone.
const TEAM_TZ = "Europe/Copenhagen";
const wallClockParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TEAM_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Split a UTC instant into team-local `YYYY-MM-DD` + `HH:MM`. */
function toWallClock(iso: string): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const { type, value } of wallClockParts.formatToParts(new Date(iso))) {
    p[type] = value;
  }
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
  };
}

/**
 * Today's calendar date in the *team's* timezone, `YYYY-MM-DD`. Distinct from
 * {@link localToday}, which follows the machine — the two differ when the
 * machine is abroad, and a date window should mean Danish days either way.
 */
export function teamToday(): string {
  return toWallClock(new Date().toISOString()).date;
}

/**
 * A `YYYY-MM-DD` calendar date shifted by `days`. Anchored at midday UTC so a
 * DST transition can never round the result onto the neighbouring day.
 */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  }
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** An activity's calendar day in the team's timezone; `""` when it has no start. */
function activityDay(a: ActivitySummary): string {
  return a.time ? toWallClock(a.time).date : "";
}

/**
 * Your own sign-up on one activity, read from REST.
 *
 * The authority is your row in the activity's `activities_users` list — *not*
 * the activity's top-level `status` field. The two disagree: on a team whose
 * activities sign everyone up by default, the row reads `Tilmeldt` while the
 * top-level field still reads 0, because that field only reflects an explicit
 * action of yours. Verified against production on two accounts with opposite
 * conventions.
 */
export interface MyAttendance {
  activity_id: number;
  /** Server status code from your row; `-1` when you have no row at all. */
  code: number;
  /**
   * The server's own label — `Tilmeldt`, `Afmeldt`, `Til rådighed`, `Ukendt`,
   * … — passed through verbatim rather than mapped, since the code set is open.
   * An availability activity, where the coach picks the squad, answers
   * 3/`Til rådighed`; 5/`Ukendt` is a row created by rostering the whole squad
   * onto an activity, before you have answered. `""` when you have no row.
   */
  label: string;
  /** When you last changed it, ISO-8601; `""` when you have no row. */
  updated_at: string;
  /**
   * Whether Holdsport will accept a change right now.
   *
   * False once registration closes. The activity list already carries the
   * allowed `actions`, so this costs nothing extra — and without it a caller
   * offers a choice the server will refuse, which reads to the user as the
   * tool being broken rather than the deadline having passed.
   */
  can_respond: boolean;
  /**
   * The answers this activity is offering, as the server names them.
   *
   * Carried because *which* answers exist varies and a caller cannot infer
   * them: an ordinary activity offers `Tilmeld`/`Afmeld`, while one where the
   * coach picks the squad offers `Til rådighed`/`Afmeld` and no `Tilmeld` at
   * all. A UI that hardcodes "Tilmeld" therefore promises the wrong thing —
   * putting yourself forward for selection is not the same commitment as
   * signing up, and the coach reads them differently.
   *
   * `joined_status` is the code the answer is *submitted* as — 0 for
   * `Til rådighed`, 1 for `Tilmeld`, 2 for `Afmeld` — which is a different
   * vocabulary from `code` above: the same "Til rådighed" reads back as 3.
   *
   * Free: the activity list already carries `actions`, the same array
   * `can_respond` is derived from. `[]` exactly when `can_respond` is false.
   */
  offers: Array<{ name: string; joined_status: number }>;
}

/**
 * The answers an activity's `actions` array is offering, parsed once.
 *
 * Both `offers` and `can_respond` on {@link MyAttendance} come from this, so an
 * activity cannot be reported answerable while offering nothing a caller could
 * actually submit.
 */
function offeredAnswers(
  actions?: Array<{ activities_user?: unknown } | null> | null,
): Array<{ name: string; joined_status: number }> {
  return (actions ?? []).flatMap((x) => {
    const u = x?.activities_user;
    if (!u || typeof u !== "object") return [];
    const row = u as Record<string, unknown>;
    // An absent or non-numeric code is dropped rather than carried as NaN,
    // which would count as an answer on offer and then match nothing. A
    // numeric code this client does not recognise is kept — the server is the
    // authority on what it will accept.
    //
    // null and "" are excluded explicitly because Number() turns both into 0,
    // and 0 is a real answer ("Til rådighed") rather than a rejected sentinel.
    const raw = row.joined_status;
    if (raw === null || raw === undefined || raw === "") return [];
    const joined = Number(raw);
    if (!Number.isFinite(joined)) return [];
    return [{ name: String(row.name ?? ""), joined_status: joined }];
  });
}

/**
 * Validate a paging window.
 *
 * Shared because both paging methods compare dates as strings: an unpadded
 * "2026-6-30" sorts below every real date, so the window never closes and the
 * call pages to its limit returning rows well outside the range. Having this
 * in one place is what stops the two methods drifting apart again.
 */
function checkWindow(
  from: string,
  to: string | undefined,
  maxPages: number,
): void {
  for (const [name, v] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new Error(`${name} must be YYYY-MM-DD, got "${v}"`);
    }
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`maxPages must be a positive whole number, got ${maxPages}`);
  }
}

/** The shape we read out of a REST activity row. */
interface RestActivity {
  id: number;
  starttime?: string;
  actions?: Array<{ activities_user?: unknown } | null> | null;
  activities_users?: Array<{
    user_id?: number;
    status?: string;
    status_code?: number;
    updated_at?: string;
  }> | null;
}

/**
 * Throw if a new activity's fields are malformed. Runs client-side before any
 * network call (and powers the CLI's dry-run preview), so a payload the server
 * might misread never reaches production. The GraphQL schema types these as
 * bare Strings; the formats below match the ones the API emits elsewhere
 * (`filter_start_date` is `YYYY-MM-DD`) and the app's 24-hour clock.
 */
export function validateNewActivity(a: NewActivity): void {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!a.name.trim()) throw new Error("activity name must not be empty");
  if (!date.test(a.date)) {
    throw new Error(`start date must be YYYY-MM-DD, got "${a.date}"`);
  }
  if (!time.test(a.start_time)) {
    throw new Error(
      `start time must be HH:MM (24-hour), got "${a.start_time}"`,
    );
  }
  if (a.end_time !== undefined && !time.test(a.end_time)) {
    throw new Error(`end time must be HH:MM (24-hour), got "${a.end_time}"`);
  }
  if (a.end_date !== undefined && !date.test(a.end_date)) {
    throw new Error(`end date must be YYYY-MM-DD, got "${a.end_date}"`);
  }
  if (a.meeting_time !== undefined && !time.test(a.meeting_time)) {
    throw new Error(
      `meeting time must be HH:MM (24-hour), got "${a.meeting_time}"`,
    );
  }
  // The CLI and MCP server pass this through from user input, so the union
  // type is no guarantee.
  if (
    a.registration_type !== undefined &&
    !(a.registration_type in REGISTRATION_TYPES)
  ) {
    throw new Error(
      `registration type must be one of ${Object.keys(REGISTRATION_TYPES).join(
        ", ",
      )}; got "${a.registration_type}"`,
    );
  }
  // HH:MM compares correctly as a string; only guard same-day activities.
  if (
    a.end_time !== undefined &&
    (a.end_date === undefined || a.end_date === a.date) &&
    a.end_time <= a.start_time
  ) {
    throw new Error(
      `end time ${a.end_time} is not after start time ${a.start_time}`,
    );
  }
}

/** A single activity with its full attendance breakdown, shaped for humans. */
export interface ActivityDetail {
  id: number;
  name: string;
  time: string;
  end_time: string;
  place: string;
  /** Meeting time (Mødetid), team-local `HH:MM`; empty when not set. */
  meeting_time: string;
  comment: string;
  event_type: string;
  /**
   * Sign-up mode (Tilmeldingstype) name; see {@link REGISTRATION_TYPES}. A
   * code this client doesn't know surfaces as the bare number, e.g. `"7"`.
   */
  registration_type: string;
  is_cancelled: boolean;
  counts: { attending: number; players: number; coaches: number; max: number };
  /** Names in each attendance bucket. */
  attendance: {
    attending_players: string[];
    attending_coaches: string[];
    not_attending: string[];
    no_answer: string[];
  };
  waiting_list: number;
  tasks: number;
}

/** Mint an access token from a login username + password. */
const SIGN_IN = `mutation SignIn($username: String, $password: String) {
  SignIn(input: { username: $username, password: $password }) {
    access_token
  }
}`;

/** Field set shared by both chat-room sources in the list query. */
const ROOM_SUMMARY_FIELDS = `
      id
      name
      scope
      unread_count
      activity { id name }
      latest_chat_message {
        text
        created_at { iso8601 }
        user { id name firstname }
      }`;

/**
 * List the current user's chat rooms with a one-line preview of each. Pulls two
 * sources the web app shows together: the ad-hoc rooms the user is a member of
 * (`rooms_users_chat_rooms`, scope `rooms_users`) and the team-scoped rooms
 * across all their teams (`chat_rooms_scoped`: team / coach / parent chats).
 */
const LIST_CHAT_ROOMS = `query ListChatRooms {
  current_user {
    id
    rooms_users_chat_rooms {${ROOM_SUMMARY_FIELDS}
    }
    teams {
      id
      chat_rooms_scoped {${ROOM_SUMMARY_FIELDS}
      }
    }
  }
}`;

/** Raw GraphQL shape of a chat room in the list query, before shaping. */
interface RawRoomSummary {
  id: number;
  name?: string;
  scope?: string;
  unread_count?: number;
  activity?: { id: number; name?: string } | null;
  latest_chat_message?: {
    text?: string;
    created_at?: { iso8601?: string } | null;
    user?: { name?: string; firstname?: string } | null;
  } | null;
}

/** A single room with its full message history. */
const SHOW_CHAT_ROOM = `query ShowChatRoom($id: Int!) {
  chat_room(id: $id) {
    id
    name
    scope
    unread_count
    chat_messages {
      id
      text
      created_at { iso8601 to_i }
      user { id name firstname }
      images { id url }
    }
  }
}`;

/** Field set shared by the inbox/sent list queries. */
const EMAIL_SUMMARY_FIELDS = `
    id
    subject
    has_been_read
    created_at { iso8601 }
    sender { id name }
    attachment1_name`;

/** List the current user's received or sent emails. */
const emailListQuery = (root: "received_emails" | "sent_emails") =>
  `query ListEmails {
  ${root} {${EMAIL_SUMMARY_FIELDS}
  }
}`;

/** A single email with its body and attachments. */
const SHOW_EMAIL = `query ShowEmail($id: Int!) {
  email(id: $id) {
    id
    subject
    content
    has_been_read
    created_at { iso8601 }
    sender { id name }
    recipients { id name }
    attachment1_name
    attachment1_url
    attachment2_name
    attachment2_url
    attachment3_name
    attachment3_url
  }
}`;

/** Raw GraphQL shape of an email, before shaping. */
interface RawEmail {
  id: number;
  subject?: string;
  content?: string;
  has_been_read?: boolean;
  created_at?: { iso8601?: string } | null;
  sender?: { name?: string } | null;
  recipients?: Array<{ name?: string }> | null;
  attachment1_name?: string | null;
  attachment1_url?: string | null;
  attachment2_name?: string | null;
  attachment2_url?: string | null;
  attachment3_name?: string | null;
  attachment3_url?: string | null;
}

/** Per-activity fields shared by the rich list and detail queries. */
const ACTIVITY_FIELDS = `
    id
    name
    place
    pickup_time
    is_cancelled
    starttime { iso8601 }
    endtime { iso8601 }
    event_type { name }
    attendee_count
    max_attender
    has_waiting_list
    absolute_registration_deadline { iso8601 }
    teams { id name }`;

/**
 * The team's activities from `filter_start_date` onward, paginated and grouped
 * by the server. We read `activities_groups` — which filters by date, so it
 * keeps activities whose day is today even once they've started — and flatten
 * it. (The sibling `future_activities_groups` cuts off at the current moment
 * instead, hiding an activity that's happening right now.) Pages are 0-indexed.
 */
const LIST_ACTIVITIES = `query ListActivities($team: String, $start: String, $page: Int) {
  activities_page(team_id: $team, filter_start_date: $start, page: $page) {
    current_page
    activities_groups {
      activities {${ACTIVITY_FIELDS}
      }
    }
  }
}`;

/** A single activity with its full attendance breakdown. */
const SHOW_ACTIVITY = `query ShowActivity($id: Int!) {
  activity(id: $id) {${ACTIVITY_FIELDS}
    comment
    type
    player_count
    coach_count
    attending_players { id name }
    attending_coaches { id name }
    non_attendees { id name }
    users_with_no_rsvp { id name }
    wait_list_entries { id }
    custom_tasks { id }
  }
}`;

/** The event types a team's activities can be filed under. */
const LIST_EVENT_TYPES = `query ListEventTypes($team: Int) {
  activities_event_types(team_id: $team) {
    id
    name
    color
  }
}`;

/**
 * Switch the session's current team. `CreateActivity` takes no team argument —
 * it applies to whichever team is current — so creating must switch first and
 * verify the `team` echoed back before writing anything.
 */
const CHANGE_CURRENT_TEAM = `mutation ChangeCurrentTeam($team: Int!) {
  ChangeCurrentTeam(input: { team_id: $team }) {
    team { id name }
  }
}`;

/**
 * Create an activity on the current team. The input type has many more fields
 * (payments, repeats, reminders, …); only the subset in {@link NewActivity} is
 * exposed. The mutation returns the created activity, echoed back below so the
 * caller can show exactly what production now has.
 */
const CREATE_ACTIVITY = `mutation CreateActivity($input: CreateActivityInput!) {
  CreateActivity(input: $input) {
    activity {${ACTIVITY_FIELDS}
    }
  }
}`;

/**
 * The current values of an activity's editable fields, plus the context an edit
 * needs: the owning team (to switch to before writing) and whether the activity
 * is part of a repeating series (which edits refuse to touch).
 */
const SHOW_ACTIVITY_FOR_EDIT = `query ShowActivityForEdit($id: Int!) {
  activity(id: $id) {
    id
    name
    place
    comment
    pickup_time
    starttime { iso8601 }
    endtime { iso8601 }
    event_type { id }
    max_attender
    teams { id name }
    is_repeated_activity
    is_root_of_repeated_activities
    has_future_repeated_activities
    is_payment_activity
    type
    reminder2
    reminder5
    hide_unattend
    ride_enabled
    ride_comment
    only_player_participation_counts
    has_waiting_list
    hide_activity_players_registration
    pickup_place
    rating
    absolute_registration_deadline { iso8601 }
    registration_start_at { iso8601 }
  }
}`;

/**
 * Update an activity. The input mirrors `CreateActivityInput` plus the target
 * `id`; like create, it applies against the session's current team, so the
 * caller switches (and verifies) first.
 */
const UPDATE_ACTIVITY = `mutation UpdateActivity($input: UpdateActivityInput!) {
  UpdateActivity(input: $input) {
    activity {${ACTIVITY_FIELDS}
    }
  }
}`;

/** Raw GraphQL shape of an activity row, before shaping. */
interface RawActivity {
  id: number;
  name?: string;
  place?: string;
  pickup_time?: string | null;
  is_cancelled?: boolean;
  starttime?: { iso8601?: string } | null;
  endtime?: { iso8601?: string } | null;
  event_type?: { name?: string } | null;
  attendee_count?: number;
  max_attender?: number | null;
  has_waiting_list?: boolean | null;
  absolute_registration_deadline?: { iso8601?: string } | null;
  teams?: Array<{ id?: number; name?: string }> | null;
}

/** Holdsport's sentinel for "no limit". */
const UNCAPPED = 999;

/** Shape a raw GraphQL activity row for humans. */
function toActivitySummary(a: RawActivity): ActivitySummary {
  return {
    id: a.id,
    name: (a.name ?? "").trim(),
    time: a.starttime?.iso8601 ?? "",
    end_time: a.endtime?.iso8601 ?? "",
    place: (a.place ?? "").trim(),
    meeting_time: (a.pickup_time ?? "").trim(),
    event_type: (a.event_type?.name ?? "").trim(),
    is_cancelled: a.is_cancelled ?? false,
    attendee_count: a.attendee_count ?? 0,
    max_attendees:
      a.max_attender && a.max_attender > 0 && a.max_attender !== UNCAPPED
        ? a.max_attender
        : null,
    has_waiting_list: a.has_waiting_list ?? false,
    registration_deadline: a.absolute_registration_deadline?.iso8601 ?? "",
    teams: (a.teams ?? [])
      // Keyed on id, not name: a team whose name comes back blank is still a
      // team the activity is shared with, and dropping it would tell a caller
      // matching on id that the session is private.
      .filter((t): t is { id: number; name?: string } => typeof t.id === "number")
      .map((t) => ({ id: t.id, name: (t.name ?? "").trim() })),
  };
}

/** Raw GraphQL shape of the for-edit activity read, before shaping. */
interface RawActivityForEdit {
  id: number;
  name?: string;
  place?: string | null;
  comment?: string | null;
  pickup_time?: string | null;
  starttime?: { iso8601?: string } | null;
  endtime?: { iso8601?: string } | null;
  event_type?: { id?: number } | null;
  max_attender?: number | null;
  teams?: Array<{ id: number; name?: string }> | null;
  is_repeated_activity?: boolean;
  is_root_of_repeated_activities?: boolean;
  has_future_repeated_activities?: boolean;
  is_payment_activity?: boolean;
  type?: number | null;
  reminder2?: number | null;
  reminder5?: number | null;
  hide_unattend?: boolean | null;
  ride_enabled?: boolean | null;
  ride_comment?: string | null;
  only_player_participation_counts?: boolean | null;
  has_waiting_list?: boolean | null;
  hide_activity_players_registration?: boolean | null;
  pickup_place?: string | null;
  rating?: string | null;
  absolute_registration_deadline?: { iso8601?: string } | null;
  registration_start_at?: { iso8601?: string } | null;
}

/**
 * Map {@link NewActivity} onto the field names of `CreateActivityInput` /
 * `UpdateActivityInput`, omitting fields that weren't given.
 *
 * Date + time go combined into `start_time` / `end_time`: the resolvers ignore
 * the separate `start_date` / `end_date` input fields and parse the time
 * fields as full datetimes — a bare "HH:MM" lands on TODAY's date (verified
 * against production for both create and update).
 */
function activityInput(activity: NewActivity): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: activity.name.trim(),
    start_time: `${activity.date} ${activity.start_time}`,
  };
  if (activity.end_time !== undefined) {
    input.end_time = `${activity.end_date ?? activity.date} ${activity.end_time}`;
  }
  if (activity.meeting_time !== undefined) {
    input.pickup_time = activity.meeting_time;
  }
  if (activity.event_type_id !== undefined) {
    input.event_type_id = activity.event_type_id;
  }
  if (activity.place !== undefined) input.place = activity.place;
  if (activity.comment !== undefined) input.comment = activity.comment;
  if (activity.max_attendees !== undefined) {
    input.max_number_of_attendees = activity.max_attendees;
  }
  if (activity.registration_type !== undefined) {
    input.activity_type = REGISTRATION_TYPES[activity.registration_type];
  }
  return input;
}

/** Raw GraphQL shape of the rich activity detail, before shaping. */
interface RawActivityDetail extends RawActivity {
  comment?: string;
  type?: number | null;
  player_count?: number;
  coach_count?: number;
  max_attender?: number;
  attending_players?: Array<{ name?: string }> | null;
  attending_coaches?: Array<{ name?: string }> | null;
  non_attendees?: Array<{ name?: string }> | null;
  users_with_no_rsvp?: Array<{ name?: string }> | null;
  wait_list_entries?: Array<{ id: number }> | null;
  custom_tasks?: Array<{ id: number }> | null;
}

/**
 * Process-level cache of GraphQL access tokens, keyed by endpoint + login
 * username so a token minted for one login is never handed to another. It is
 * shared across client instances on purpose: the MCP server builds a fresh
 * client per tool call, so an instance-local cache would re-run `SignIn` on
 * every chat call. Sharing it lets a token be reused for the rest of the
 * session, while the key keeps each login's token separate.
 *
 * There is no expiry handling yet — call {@link clearChatTokenCache} if a token
 * ever goes stale.
 */
const accessTokenCache = new Map<string, string>();

/**
 * Drop all cached chat access tokens. Useful if a token expires; also used by
 * tests to keep `SignIn` counts deterministic.
 */
export function clearChatTokenCache(): void {
  accessTokenCache.clear();
}

export class HoldsportClient {
  constructor(private readonly config: Config) {}

  /**
   * Perform an authenticated GET and return the parsed JSON body. Throws on
   * non-2xx. This is the only REST transport — the client is read-only, so there
   * is no write path. Private: external callers use the named read methods
   * below, not an arbitrary-path escape hatch.
   */
  private async get(path: string): Promise<unknown> {
    const url = new URL(
      path.startsWith("http")
        ? path
        : `${DEFAULT_BASE_URL}/${path.replace(/^\/+/, "")}`,
    );

    const auth = Buffer.from(
      `${this.config.username}:${this.config.password}`,
    ).toString("base64");

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for GET ${url.pathname}${url.search}\n${text}`,
      );
    }

    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Resolve the target team from an explicit id, else the configured default. */
  private resolveTeam(teamId?: string): string {
    const team = teamId ?? this.config.teamId;
    if (!team) {
      throw new Error(
        "no team set: pass a team id or configure a default team " +
          "(CLI: --team / HOLDSPORT_TEAM_ID; MCP: team_id / --team-id)",
      );
    }
    return String(team);
  }

  listTeams(): Promise<unknown> {
    return this.get("teams");
  }

  listMembers(teamId?: string): Promise<unknown> {
    return this.get(`teams/${this.resolveTeam(teamId)}/members`);
  }

  getMember(memberId: string, teamId?: string): Promise<unknown> {
    return this.get(`teams/${this.resolveTeam(teamId)}/members/${memberId}`);
  }

  /** Contact list shaped for humans: name/role/mobile/email per member. */
  async roster(
    teamId?: string,
    opts: { players?: boolean; staff?: boolean } = {},
  ): Promise<RosterEntry[]> {
    const data = await this.get(`teams/${this.resolveTeam(teamId)}/members`);
    let members = (Array.isArray(data) ? data : []) as MemberRecord[];

    if (opts.players) members = members.filter((m) => m.role === 1);
    if (opts.staff) members = members.filter((m) => m.role === 2);

    const roleLabel = (role?: number) =>
      role === 1 ? "player" : role === 2 ? "staff" : String(role ?? "");
    // Holdsport returns the string "false" as a null sentinel for empty fields.
    const distinct = (values: Array<unknown>) =>
      [
        ...new Set(
          values
            .map((v) => String(v ?? "").trim())
            .filter((s) => s && s.toLowerCase() !== "false"),
        ),
      ].join("; ");

    return members
      .map((m) => {
        const addrs = m.addresses ?? [];
        return {
          name: `${m.firstname ?? ""} ${m.lastname ?? ""}`
            .replace(/\s+/g, " ")
            .trim(),
          role: roleLabel(m.role),
          birthday: m.birthday ?? "",
          mobile: distinct(addrs.map((a) => a.mobile)),
          email: distinct(addrs.map((a) => a.email)),
          member_number: m.member_number ?? "",
        };
      })
      .sort(
        (a, b) =>
          a.role.localeCompare(b.role) || a.name.localeCompare(b.name, "da"),
      );
  }

  listNotes(teamId?: string): Promise<unknown> {
    return this.get(`teams/${this.resolveTeam(teamId)}/notes`);
  }

  listTasks(activityId: string): Promise<unknown> {
    return this.get(`activities/${activityId}/activity_tasks`);
  }

  getUser(): Promise<unknown> {
    return this.get("user");
  }

  listProfiles(): Promise<unknown> {
    return this.get("profiles");
  }

  // --- Chat (GraphQL) ------------------------------------------------------
  //
  // Chat lives on a separate GraphQL endpoint with its own auth. These helpers
  // keep that self-contained: `graphql` is the transport, `accessToken` mints +
  // caches the token, and the public `listChatRooms`/`chatRoom` shape the result.

  /**
   * POST a GraphQL operation and return its `data`. Sends the `X-App-Version`
   * gate header (without it the server answers `{}`); authenticated operations
   * also carry the raw `Authorization` token. Throws on HTTP errors, on a
   * GraphQL `errors` array, and on the empty-`{}` gate response.
   */
  private async graphql(
    query: string,
    variables: Record<string, unknown> = {},
    opts: { authenticated?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const url = DEFAULT_GRAPHQL_URL;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-App-Version": APP_VERSION,
    };
    if (opts.authenticated !== false) {
      headers.Authorization = await this.accessToken();
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for GraphQL\n${text}`,
      );
    }

    let body: {
      data?: Record<string, unknown>;
      errors?: Array<{ message?: string }>;
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`GraphQL returned non-JSON: ${text.slice(0, 200)}`);
    }

    if (body.errors?.length) {
      throw new Error(
        `GraphQL error: ${body.errors.map((e) => e.message ?? "?").join("; ")}`,
      );
    }
    if (!body.data) {
      // An empty `{}` means the X-App-Version gate rejected us (or the endpoint
      // isn't the GraphQL one). Surface it clearly rather than as "undefined".
      throw new Error(
        "GraphQL returned no data (the X-App-Version gate may have rejected the request).",
      );
    }
    return body.data;
  }

  /**
   * The GraphQL access token, minting one via `SignIn` on first use and caching
   * it in the process-level {@link accessTokenCache} (keyed by login) for reuse
   * across calls.
   */
  private async accessToken(): Promise<string> {
    // Key the cache by username, so a token minted for one set of
    // credentials is never served to a different login within the process.
    const username = this.config.username;
    const cached = accessTokenCache.get(username);
    if (cached) return cached;
    // TODO: no token-expiry handling. A cached token can go stale mid-session,
    // and the API signals that with a null `current_user` / null `data` rather
    // than an HTTP 401 — so a read just comes back empty instead of erroring. To
    // auto-recover, detect that empty/unauthenticated shape in the read methods,
    // evict this key, and re-SignIn + retry once. For now a stale token needs
    // clearChatTokenCache() or a process restart.

    const data = await this.graphql(
      SIGN_IN,
      { username, password: this.config.password },
      { authenticated: false },
    );
    const token = (data.SignIn as { access_token?: string } | null)
      ?.access_token;
    if (!token) {
      throw new Error(
        "SignIn returned no access_token. Chat/email needs the login username " +
          "(not email / member number) — check HOLDSPORT_USERNAME / --user.",
      );
    }
    accessTokenCache.set(username, token);
    return token;
  }

  /**
   * The current user's chat rooms — both the ad-hoc rooms they belong to and the
   * team-scoped rooms across all their teams — deduped and most-recently-active
   * first. (Reading the messages of any of them works through `chatRoom`, which
   * fetches by id regardless of scope.)
   */
  async listChatRooms(): Promise<ChatRoomSummary[]> {
    const data = await this.graphql(LIST_CHAT_ROOMS);
    const user = data.current_user as {
      rooms_users_chat_rooms?: RawRoomSummary[];
      teams?: Array<{ chat_rooms_scoped?: RawRoomSummary[] }>;
    } | null;

    // Merge both sources; a room can be reachable via more than one relation, so
    // dedupe by id (the ad-hoc membership row wins as it comes first).
    const byId = new Map<number, RawRoomSummary>();
    for (const r of [
      ...(user?.rooms_users_chat_rooms ?? []),
      ...(user?.teams ?? []).flatMap((t) => t.chat_rooms_scoped ?? []),
    ]) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }

    return [...byId.values()]
      .map((r): ChatRoomSummary => {
        const last = r.latest_chat_message;
        return {
          id: r.id,
          name: (r.name ?? "").trim(),
          scope: r.scope ?? "",
          unread_count: r.unread_count ?? 0,
          last_message: last
            ? {
                author: (last.user?.name ?? last.user?.firstname ?? "").trim(),
                text: last.text ?? "",
                time: last.created_at?.iso8601 ?? "",
              }
            : null,
          activity: r.activity
            ? { id: r.activity.id, name: (r.activity.name ?? "").trim() }
            : null,
        };
      })
      .sort((a, b) =>
        (b.last_message?.time ?? "").localeCompare(a.last_message?.time ?? ""),
      );
  }

  /**
   * A single chat room with its messages, oldest first. `limit`, when given,
   * keeps only the most recent N messages (still shown chronologically); the
   * GraphQL API has no server-side limit, so this trims client-side.
   */
  async chatRoom(
    roomId: string | number,
    limit?: number,
  ): Promise<ChatRoomDetail> {
    const data = await this.graphql(SHOW_CHAT_ROOM, { id: Number(roomId) });
    const room = data.chat_room as {
      id: number;
      name?: string;
      scope?: string;
      unread_count?: number;
      chat_messages?: Array<{
        id: number;
        text?: string;
        created_at?: { iso8601?: string; to_i?: number } | null;
        user?: { name?: string; firstname?: string } | null;
        images?: Array<{ url?: string }> | null;
      }>;
    } | null;
    if (!room) throw new Error(`chat room ${roomId} not found`);

    let messages = (room.chat_messages ?? [])
      .map((m) => ({
        id: m.id,
        time: m.created_at?.iso8601 ?? "",
        ts: m.created_at?.to_i ?? 0,
        author: (m.user?.name ?? m.user?.firstname ?? "").trim(),
        text: m.text ?? "",
        images: (m.images ?? []).map((img) => img.url ?? "").filter((u) => u),
      }))
      .sort((a, b) => a.ts - b.ts);

    // Trim to the most recent N, but keep them in chronological order.
    if (limit !== undefined && limit >= 0 && messages.length > limit) {
      messages = messages.slice(messages.length - limit);
    }

    return {
      id: room.id,
      name: (room.name ?? "").trim(),
      scope: room.scope ?? "",
      unread_count: room.unread_count ?? 0,
      messages: messages.map(({ ts: _ts, ...m }) => m),
    };
  }

  /**
   * The current user's emails, most-recent first. Reads the inbox by default,
   * or the sent box with `sent: true`. `limit` keeps only the most recent N.
   */
  async listEmails(
    opts: { sent?: boolean; limit?: number } = {},
  ): Promise<EmailSummary[]> {
    const root = opts.sent ? "sent_emails" : "received_emails";
    const data = await this.graphql(emailListQuery(root));
    const raw = (data[root] as RawEmail[] | null) ?? [];

    const emails = raw
      .map(
        (e): EmailSummary => ({
          id: e.id,
          subject: (e.subject ?? "").trim(),
          sender: (e.sender?.name ?? "").trim(),
          time: e.created_at?.iso8601 ?? "",
          has_been_read: e.has_been_read ?? false,
          has_attachments: Boolean(e.attachment1_name),
        }),
      )
      .sort((a, b) => b.time.localeCompare(a.time));

    return opts.limit !== undefined && opts.limit >= 0
      ? emails.slice(0, opts.limit)
      : emails;
  }

  /** A single email with its body, recipients, and attachments. */
  async getEmail(emailId: string | number): Promise<EmailDetail> {
    const data = await this.graphql(SHOW_EMAIL, { id: Number(emailId) });
    const e = data.email as RawEmail | null;
    if (!e) throw new Error(`email ${emailId} not found`);

    const attachments: EmailAttachment[] = [
      { name: e.attachment1_name, url: e.attachment1_url },
      { name: e.attachment2_name, url: e.attachment2_url },
      { name: e.attachment3_name, url: e.attachment3_url },
    ]
      .filter((a) => a.name)
      .map((a) => ({ name: a.name ?? "", url: a.url ?? "" }));

    return {
      id: e.id,
      subject: (e.subject ?? "").trim(),
      sender: (e.sender?.name ?? "").trim(),
      recipients: (e.recipients ?? [])
        .map((r) => (r.name ?? "").trim())
        .filter((n) => n),
      time: e.created_at?.iso8601 ?? "",
      has_been_read: e.has_been_read ?? false,
      content: e.content ?? "",
      attachments,
    };
  }

  // --- Activities (GraphQL) ------------------------------------------------

  /**
   * The team's activities, one page at a time, from `date` onward (defaults to
   * today, in local time). Filtering is by date, so today's activities show up
   * even after they've started. Each row carries its event type, place, and a
   * live sign-up count. `page` is 1-based for callers; the server is 0-based.
   */
  async listActivities(
    opts: { teamId?: string; date?: string; page?: number } = {},
  ): Promise<ActivitySummary[]> {
    const team = this.resolveTeam(opts.teamId);
    const start = opts.date ?? localToday();
    const data = await this.graphql(LIST_ACTIVITIES, {
      team,
      start,
      page: (opts.page ?? 1) - 1,
    });
    const page = data.activities_page as {
      activities_groups?: Array<{ activities?: RawActivity[] }>;
    } | null;

    return (page?.activities_groups ?? [])
      .flatMap((g) => g.activities ?? [])
      .map(toActivitySummary)
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  /**
   * Every activity for a team inside an inclusive `from`..`to` date window,
   * assembled by paging {@link listActivities}. The server has no end-date
   * filter — `activities_page` takes only a start date — so the far edge of the
   * window is applied here.
   *
   * Days are compared as *team-local* calendar days, not raw instants: a 00:30
   * activity on the window's last day is 22:30Z the day before, and comparing
   * ISO timestamps would drop it. Local days are what a person means by "the
   * next month".
   *
   * Termination is deliberate: `activities_page` reports neither a total nor a
   * has-more flag, so the loop stops on the first empty page, or once a page's
   * last row has passed `to`, with `maxPages` as the backstop against a team
   * whose calendar never runs out.
   */
  async activitiesInRange(
    opts: {
      teamId?: string;
      from?: string;
      to?: string;
      maxPages?: number;
    } = {},
  ): Promise<ActivitySummary[]> {
    const from = opts.from ?? teamToday();
    const { to } = opts;
    const maxPages = opts.maxPages ?? 12;
    checkWindow(from, to, maxPages);

    const seen = new Set<number>();
    const kept: ActivitySummary[] = [];
    let exhausted = true;

    for (let page = 1; page <= maxPages; page++) {
      const rows = await this.listActivities({
        teamId: opts.teamId,
        date: from,
        page,
      });
      if (rows.length === 0) {
        exhausted = false;
        break;
      }

      for (const row of rows) {
        if (to !== undefined && activityDay(row) > to) continue;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        kept.push(row);
      }

      // Rows arrive sorted ascending, so the last one dates the page.
      if (to !== undefined && activityDay(rows[rows.length - 1]!) > to) {
        exhausted = false;
        break;
      }
    }

    // Running out of pages is not the same as running out of activities, and a
    // truncated list is indistinguishable from a complete one — a caller would
    // report "nothing scheduled in December" for a window it never reached.
    if (exhausted) {
      throw new Error(
        `activitiesInRange stopped at the ${maxPages}-page limit without reaching ` +
          `the end of the window; raise maxPages or narrow the range`,
      );
    }

    return kept.sort((a, b) => a.time.localeCompare(b.time));
  }

  /**
   * Your own sign-up for each activity in a date window, keyed by activity id.
   *
   * This is the one read that goes to **REST** rather than GraphQL: the
   * documented `teams/:id/activities` endpoint carries the caller's attendance
   * inline, so a whole team's worth costs one request per page — where GraphQL
   * would need a per-activity round-trip and name-matching against the
   * attendee lists.
   *
   * Unlike {@link listActivities}, REST pages are 1-based (`page=1` is the
   * first) and take an explicit `per_page`.
   */
  async myAttendance(
    opts: {
      teamId?: string;
      from?: string;
      to?: string;
      maxPages?: number;
    } = {},
  ): Promise<Record<number, MyAttendance>> {
    const team = this.resolveTeam(opts.teamId);
    const from = opts.from ?? teamToday();
    const { to } = opts;
    const maxPages = opts.maxPages ?? 12;

    checkWindow(from, to, maxPages);

    const me = (await this.getUser()) as { id?: number } | null;
    const myId = me?.id;
    if (typeof myId !== "number") {
      throw new Error("could not read your own user id from GET /user");
    }

    const found: Record<number, MyAttendance> = {};
    let exhausted = true;

    for (let page = 1; page <= maxPages; page++) {
      const rows =
        ((await this.get(
          `teams/${team}/activities?date=${encodeURIComponent(from)}` +
            `&page=${page}&per_page=50`,
        )) as RestActivity[] | null) ?? [];
      if (rows.length === 0) {
        exhausted = false;
        break;
      }

      for (const a of rows) {
        const day = a.starttime ? toWallClock(a.starttime).date : "";
        if (to !== undefined && day > to) continue;
        const mine = (a.activities_users ?? []).find(
          (u) => u.user_id === myId,
        );
        const offers = offeredAnswers(a.actions);
        found[a.id] = {
          activity_id: a.id,
          // -1 means "no row at all", so it has to come from the row being
          // absent. A row that exists with no status_code is a different
          // state, and a caller branching on -1 to mean "not asked yet" would
          // offer to sign up someone who already has an answer recorded.
          code: mine === undefined ? -1 : (mine.status_code ?? 0),
          label: (mine?.status ?? "").trim(),
          updated_at: mine?.updated_at ?? "",
          // An entry without an activities_user carries no answer, so an
          // activity holding only those accepts nothing despite a non-empty
          // array. Counting the array's length would call it open and the
          // write would then be refused.
          //
          // Derived from the same parse as `offers`, so "answerable" means an
          // answer is actually on offer rather than merely that the array was
          // non-empty.
          offers,
          can_respond: offers.length > 0,
        };
      }

      const last = rows[rows.length - 1]!;
      const lastDay = last.starttime ? toWallClock(last.starttime).date : "";
      if (to !== undefined && lastDay > to) {
        exhausted = false;
        break;
      }
    }

    // Same reasoning as activitiesInRange: a partial map is indistinguishable
    // from a complete one, so a caller would report "no sign-up recorded" for
    // activities it simply never fetched. Note the page budgets are not
    // comparable — REST pages here hold 50, GraphQL pages do not — so a
    // maxPages tuned for one method truncates the other.
    if (exhausted) {
      throw new Error(
        `myAttendance stopped at the ${maxPages}-page limit without reaching ` +
          `the end of the window; raise maxPages or narrow the range`,
      );
    }

    return found;
  }

  /**
   * The event types a team's activities can be filed under — the valid
   * `event_type_id` values for {@link createActivity}.
   */
  async listEventTypes(teamId?: string): Promise<EventType[]> {
    const team = Number(this.resolveTeam(teamId));
    const data = await this.graphql(LIST_EVENT_TYPES, { team });
    const raw =
      (data.activities_event_types as Array<{
        id: number;
        name?: string;
        color?: string;
      }> | null) ?? [];
    return raw.map((t) => ({
      id: t.id,
      name: (t.name ?? "").trim(),
      color: t.color ?? "",
    }));
  }

  /**
   * Create an activity on the team's calendar. **This writes to production.**
   *
   * `CreateActivity` has no team argument — it targets the session's *current*
   * team — so this switches the current team first via `ChangeCurrentTeam` and
   * refuses to write unless the server confirms the switch landed on the
   * requested team. (Side effect: the user's "current team" in the Holdsport
   * app changes to the target team.)
   *
   * The payload is validated client-side ({@link validateNewActivity}) before
   * any request is sent. Returns the created activity as echoed back by the
   * server, so callers can show exactly what now exists.
   */
  async createActivity(
    activity: NewActivity,
    teamId?: string,
  ): Promise<ActivitySummary> {
    const team = Number(this.resolveTeam(teamId));
    validateNewActivity(activity);
    await this.switchToTeam(team);

    const data = await this.graphql(CREATE_ACTIVITY, {
      input: activityInput(activity),
    });
    const created = (
      data.CreateActivity as { activity?: RawActivity | null } | null
    )?.activity;
    if (!created) {
      throw new Error(
        "CreateActivity returned no activity — it may not have been created " +
          "(check the team's calendar), or your login may lack admin rights.",
      );
    }
    return toActivitySummary(created);
  }

  /**
   * An activity's current editable fields (converted to team-local wall clock),
   * its owning team, and its repeat flag — everything an edit needs up front,
   * and what the CLI's dry-run diff is rendered from.
   */
  async activityForEdit(activityId: string | number): Promise<ActivityForEdit> {
    const data = await this.graphql(SHOW_ACTIVITY_FOR_EDIT, {
      id: Number(activityId),
    });
    const a = data.activity as RawActivityForEdit | null;
    if (!a) throw new Error(`activity ${activityId} not found`);

    const start = a.starttime?.iso8601
      ? toWallClock(a.starttime.iso8601)
      : undefined;
    const end = a.endtime?.iso8601 ? toWallClock(a.endtime.iso8601) : undefined;
    const team = a.teams?.[0];

    // Everything the update mutation assigns but NewActivity doesn't cover,
    // echoed back so the server's assign-all-inputs update can't null it.
    const passthrough: Record<string, unknown> = {};
    const echo = (key: string, value: unknown) => {
      if (value !== null && value !== undefined) passthrough[key] = value;
    };
    // The registration type is editable (NewActivity.registration_type), so a
    // known code surfaces in `fields` and rides out via activityInput; only an
    // unknown code (a server value this client predates) is echoed verbatim.
    const regType =
      a.type !== null && a.type !== undefined
        ? registrationTypeName(a.type)
        : undefined;
    if (regType === undefined) echo("activity_type", a.type);
    echo("reminder2", a.reminder2);
    echo("reminder5", a.reminder5);
    echo("hide_unattend", a.hide_unattend);
    echo("ride", a.ride_enabled);
    echo("ride_comment", a.ride_comment);
    echo(
      "only_player_participation_counts",
      a.only_player_participation_counts,
    );
    echo("has_waiting_list", a.has_waiting_list);
    echo(
      "hide_activity_players_registration",
      a.hide_activity_players_registration,
    );
    echo("pickup_place", a.pickup_place);
    // `points` is deliberately not read or echoed: its resolver 500s on
    // ordinary activities (nil "Festival/Appvagt" context), and the failed
    // UPDATE's SET clause showed the mutation leaves the column alone.
    // (`is_club_activity` is create-only — UpdateActivityInput rejects it.)
    echo("rating", a.rating);
    if (a.absolute_registration_deadline?.iso8601) {
      const d = toWallClock(a.absolute_registration_deadline.iso8601);
      passthrough.absolute_registration_deadline_date = d.date;
      passthrough.absolute_registration_deadline_time = d.time;
    }
    if (a.registration_start_at?.iso8601) {
      const d = toWallClock(a.registration_start_at.iso8601);
      passthrough.registration_start_date = d.date;
      passthrough.registration_start_time = d.time;
    }

    return {
      id: a.id,
      team: team ? { id: team.id, name: (team.name ?? "").trim() } : null,
      // A series ROOT reports is_repeated_activity: false (verified live) —
      // only later occurrences carry it — so any of the three flags means
      // the activity belongs to a series. (`repeat` is no signal at all:
      // it is true even on one-offs.)
      is_repeated:
        (a.is_repeated_activity ?? false) ||
        (a.is_root_of_repeated_activities ?? false) ||
        (a.has_future_repeated_activities ?? false),
      is_payment: a.is_payment_activity ?? false,
      passthrough,
      fields: {
        name: (a.name ?? "").trim(),
        date: start?.date ?? "",
        start_time: start?.time ?? "",
        end_time: end?.time,
        end_date: end?.date,
        // The API hands back "" as well as null for "no meeting time" —
        // both mean unset, so neither should be echoed on an update.
        meeting_time: a.pickup_time?.trim() || undefined,
        event_type_id: a.event_type?.id,
        place: a.place ?? undefined,
        comment: a.comment ?? undefined,
        max_attendees: a.max_attender ?? undefined,
        registration_type: regType,
      },
    };
  }

  /**
   * Edit an activity. **This writes to production.**
   *
   * Read-modify-write: the activity's current state is fetched, `changes`
   * (any subset of {@link NewActivity}) is merged over the editable fields,
   * the merged result is validated, and the full field set is sent — the
   * editable fields plus a verbatim echo of every other server-assigned field
   * ({@link ActivityForEdit.passthrough}). The echo is not optional: the
   * mutation assigns all of its input fields and NULLs the omitted ones, so a
   * partial update would wipe reminders, deadlines, and settings. Payment
   * activities are refused outright — their payment fields can't be read
   * back, so they can't be echoed safely.
   *
   * Editing an activity in a repeating series requires an explicit
   * `repeatScope` — the same choice the app's save dialog forces: `"this"`
   * edits only this occurrence, `"future"` edits this and all future
   * occurrences. The scope maps onto the mutation's
   * `update_current_and_future` boolean. Without a scope, repeated activities
   * are refused rather than guessed at; for non-repeated activities the scope
   * is ignored. Like create, the write targets the *current team*, so this
   * switches to the activity's own team (from the activity itself, not the
   * configured default) and verifies before writing.
   */
  async updateActivity(
    activityId: string | number,
    changes: Partial<NewActivity>,
    opts: { repeatScope?: "this" | "future" } = {},
  ): Promise<ActivitySummary> {
    // Drop undefined values so sparse callers (CLI flags, MCP args) can pass
    // every key without clobbering fields they didn't mean to change.
    const given = Object.fromEntries(
      Object.entries(changes).filter(([, v]) => v !== undefined),
    ) as Partial<NewActivity>;
    if (Object.keys(given).length === 0) {
      throw new Error("nothing to change: pass at least one field to update");
    }

    const current = await this.activityForEdit(activityId);
    if (current.is_repeated && !opts.repeatScope) {
      throw new Error(
        `refusing to edit: activity ${activityId} is part of a repeating ` +
          'series — say which occurrences to change: scope "this" (only ' +
          'this one) or "future" (this and all future ones)',
      );
    }
    if (current.is_payment) {
      throw new Error(
        `refusing to edit: activity ${activityId} is a payment activity — ` +
          "its payment fields can't be safely echoed back, so an update " +
          "could corrupt them; edit it in the Holdsport app instead",
      );
    }
    if (!current.team) {
      throw new Error(
        `refusing to edit: could not determine the owning team of activity ${activityId}`,
      );
    }

    const merged: NewActivity = { ...current.fields, ...given };
    validateNewActivity(merged);
    await this.switchToTeam(current.team.id);

    // The passthrough fields ride along verbatim: the server assigns every
    // input field, NULLing the omitted ones (see ActivityForEdit.passthrough).
    const input: Record<string, unknown> = {
      id: current.id,
      ...current.passthrough,
      ...activityInput(merged),
    };
    // Only meaningful on a repeated activity; sent explicitly either way so
    // "just this one" can never be misread as "the whole series".
    if (current.is_repeated) {
      input.update_current_and_future = opts.repeatScope === "future";
    }

    const data = await this.graphql(UPDATE_ACTIVITY, { input });
    const updated = (
      data.UpdateActivity as { activity?: RawActivity | null } | null
    )?.activity;
    if (!updated) {
      throw new Error(
        "UpdateActivity returned no activity — the edit may not have been " +
          "applied (check the team's calendar), or your login may lack admin rights.",
      );
    }
    return toActivitySummary(updated);
  }

  /**
   * Switch the session's current team and verify the server landed on it —
   * the write mutations apply to the current team, so a wrong or failed
   * switch must abort before anything is written.
   */
  private async switchToTeam(team: number): Promise<void> {
    const switched = await this.graphql(CHANGE_CURRENT_TEAM, { team });
    const current = (
      switched.ChangeCurrentTeam as { team?: { id?: number } | null } | null
    )?.team;
    if (current?.id !== team) {
      throw new Error(
        `refusing to write: asked to switch to team ${team}, but the server ` +
          `reports team ${current?.id ?? "unknown"} as current`,
      );
    }
  }

  /**
   * A single activity with its full attendance breakdown: the named attending /
   * not-attending / no-answer lists plus the counts.
   */
  async getActivity(activityId: string | number): Promise<ActivityDetail> {
    const data = await this.graphql(SHOW_ACTIVITY, { id: Number(activityId) });
    const a = data.activity as RawActivityDetail | null;
    if (!a) throw new Error(`activity ${activityId} not found`);

    const names = (list?: Array<{ name?: string }> | null) =>
      (list ?? []).map((u) => (u.name ?? "").trim()).filter((n) => n);

    return {
      id: a.id,
      name: (a.name ?? "").trim(),
      time: a.starttime?.iso8601 ?? "",
      end_time: a.endtime?.iso8601 ?? "",
      place: (a.place ?? "").trim(),
      meeting_time: (a.pickup_time ?? "").trim(),
      comment: (a.comment ?? "").trim(),
      event_type: (a.event_type?.name ?? "").trim(),
      registration_type:
        a.type !== null && a.type !== undefined
          ? (registrationTypeName(a.type) ?? String(a.type))
          : "",
      is_cancelled: a.is_cancelled ?? false,
      counts: {
        attending: a.attendee_count ?? 0,
        players: a.player_count ?? 0,
        coaches: a.coach_count ?? 0,
        // Same sentinel as the summary: 999 means no limit, not a cap of 999.
        max:
          a.max_attender && a.max_attender !== UNCAPPED ? a.max_attender : 0,
      },
      attendance: {
        attending_players: names(a.attending_players),
        attending_coaches: names(a.attending_coaches),
        not_attending: names(a.non_attendees),
        no_answer: names(a.users_with_no_rsvp),
      },
      waiting_list: (a.wait_list_entries ?? []).length,
      tasks: (a.custom_tasks ?? []).length,
    };
  }
}
