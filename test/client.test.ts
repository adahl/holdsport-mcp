import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  addDays,
  type Config,
  clearChatTokenCache,
  HoldsportClient,
  loadConfig,
  teamToday,
} from "../src/client.ts";

const baseConfig: Config = {
  username: "u",
  password: "p",
  teamId: "99",
};

/** Replace global fetch with a canned-response handler for the duration of a test. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
): void {
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  ) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), { status, statusText });

describe("loadConfig", () => {
  const ENV_KEYS = [
    "HOLDSPORT_USERNAME",
    "HOLDSPORT_PASSWORD",
    "HOLDSPORT_TEAM_ID",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // Start each test from a clean env so .env values don't leak in.
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws when credentials are missing", () => {
    expect(() => loadConfig()).toThrow(/Missing credentials/);
  });

  it("reads credentials from the environment", () => {
    process.env.HOLDSPORT_USERNAME = "envuser";
    process.env.HOLDSPORT_PASSWORD = "envpass";
    process.env.HOLDSPORT_TEAM_ID = "42";
    const c = loadConfig();
    expect(c.username).toBe("envuser");
    expect(c.password).toBe("envpass");
    expect(c.teamId).toBe("42");
  });

  it("lets overrides win over the environment", () => {
    process.env.HOLDSPORT_USERNAME = "envuser";
    process.env.HOLDSPORT_PASSWORD = "envpass";
    const c = loadConfig({
      username: "argu",
      password: "argp",
      teamId: "7",
    });
    expect(c.username).toBe("argu");
    expect(c.password).toBe("argp");
    expect(c.teamId).toBe("7");
  });
});

describe("REST transport (exercised via the read methods)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a GET with Basic auth, builds the URL, and parses JSON", async () => {
    let seenUrl = "";
    let seenAuth: unknown;
    let seenMethod: unknown;
    stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return json({ ok: true });
    });
    const data = await new HoldsportClient(baseConfig).listTeams();
    expect(data).toEqual({ ok: true });
    expect(seenMethod).toBe("GET"); // read-only: the REST transport only does GET
    expect(seenUrl).toBe("https://api.holdsport.dk/v1/teams");
    expect(seenAuth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(() => json({ error: "nope" }, 404, "Not Found"));
    await expect(new HoldsportClient(baseConfig).listTeams()).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

const MEMBERS = [
  {
    id: 1,
    firstname: "Bo",
    lastname: "Berg",
    role: 1,
    birthday: "2009-01-02",
    member_number: "100",
    addresses: [
      { mobile: "111", email: "bo@x.dk" },
      { mobile: "111", email: "false" }, // duplicate mobile + "false" sentinel
    ],
  },
  {
    id: 2,
    firstname: "Ann",
    lastname: "Adler",
    role: 2,
    birthday: "1980-05-05",
    member_number: "200",
    addresses: [{ mobile: "false", email: "ann@x.dk" }],
  },
  {
    id: 3,
    firstname: "Cy",
    lastname: "Cohen",
    role: 1,
    birthday: "2010-03-03",
    member_number: "300",
    addresses: [],
  },
];

describe("HoldsportClient.roster", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    stubFetch(() => json(MEMBERS));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shapes rows, drops the 'false' sentinel, dedups, and sorts by role then name", async () => {
    const rows = await new HoldsportClient(baseConfig).roster();
    expect(rows.map((r) => r.name)).toEqual([
      "Bo Berg",
      "Cy Cohen",
      "Ann Adler",
    ]);
    expect(rows[0]).toEqual({
      name: "Bo Berg",
      role: "player",
      birthday: "2009-01-02",
      mobile: "111",
      email: "bo@x.dk",
      member_number: "100",
    });
    expect(rows[2].mobile).toBe(""); // "false" was filtered out
  });

  it("filters to players when requested", async () => {
    const rows = await new HoldsportClient(baseConfig).roster(undefined, {
      players: true,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.role === "player")).toBe(true);
  });
});

// --- Chat (GraphQL) --------------------------------------------------------

const chatConfig: Config = { ...baseConfig };

const CHAT_ROOMS = [
  {
    id: 10,
    name: "Team chat ",
    scope: "team",
    unread_count: 2,
    activity: null,
    latest_chat_message: {
      text: "see you",
      created_at: { iso8601: "2025-01-10T18:00:00+01:00" },
      user: { name: "Bo Berg ", firstname: "Bo" },
    },
  },
  {
    id: 11,
    name: "Match thread",
    scope: "activity",
    unread_count: 0,
    activity: { id: 555, name: "Match" },
    latest_chat_message: {
      text: "older",
      created_at: { iso8601: "2025-01-09T10:00:00+01:00" },
      user: { name: "Ann Adler", firstname: "Ann" },
    },
  },
  {
    id: 12,
    name: "Empty room",
    scope: "rooms_users",
    unread_count: 0,
    activity: null,
    latest_chat_message: null,
  },
];

// Deliberately out of chronological order to exercise sorting.
const CHAT_MESSAGES = [
  {
    id: 3,
    text: "third",
    created_at: { iso8601: "2025-01-10T12:00:00+01:00", to_i: 300 },
    user: { name: "Cy Cohen", firstname: "Cy" },
    images: [],
  },
  {
    id: 1,
    text: "first",
    created_at: { iso8601: "2025-01-10T10:00:00+01:00", to_i: 100 },
    user: { name: "Bo Berg", firstname: "Bo" },
    images: [{ id: 9, url: "https://img/1" }],
  },
  {
    id: 2,
    text: "second\nline",
    created_at: { iso8601: "2025-01-10T11:00:00+01:00", to_i: 200 },
    user: { name: "Ann Adler", firstname: "Ann" },
    images: [],
  },
];

/**
 * Stub the GraphQL endpoint, dispatching on the operation in the request body.
 * Returns the number of SignIn calls so tests can assert token memoization.
 */
function stubGraphql(
  opts: {
    rooms?: unknown;
    teams?: unknown;
    room?: unknown;
    received?: unknown;
    sent?: unknown;
    email?: unknown;
    activityGroups?: unknown;
    activity?: unknown;
    eventTypes?: unknown;
    /** Team echoed by ChangeCurrentTeam; defaults to the requested team. */
    currentTeam?: unknown;
    /** Activity echoed by CreateActivity; defaults to none (creation failed). */
    created?: unknown;
    /** Activity returned by the for-edit read; defaults to none (not found). */
    editActivity?: unknown;
    /** Activity echoed by UpdateActivity; defaults to none (update failed). */
    updated?: unknown;
  } = {},
): {
  signIns: () => number;
  requests: () => Array<{ auth?: string; query: string; variables?: any }>;
} {
  const requests: Array<{ auth?: string; query: string; variables?: any }> = [];
  stubFetch((_url, init) => {
    const body = JSON.parse(String(init.body));
    requests.push({
      auth: (init.headers as Record<string, string>)?.Authorization,
      query: body.query,
      variables: body.variables,
    });
    if (body.query.includes("SignIn")) {
      return json({ data: { SignIn: { access_token: "tok-123" } } });
    }
    if (body.query.includes("rooms_users_chat_rooms")) {
      return json({
        data: {
          current_user: {
            id: 1,
            rooms_users_chat_rooms: opts.rooms ?? CHAT_ROOMS,
            teams: opts.teams ?? [],
          },
        },
      });
    }
    if (body.query.includes("chat_room")) {
      return json({ data: { chat_room: opts.room ?? null } });
    }
    if (body.query.includes("received_emails")) {
      return json({ data: { received_emails: opts.received ?? [] } });
    }
    if (body.query.includes("sent_emails")) {
      return json({ data: { sent_emails: opts.sent ?? [] } });
    }
    if (body.query.includes("email(id:")) {
      return json({ data: { email: opts.email ?? null } });
    }
    if (body.query.includes("activities_event_types")) {
      return json({ data: { activities_event_types: opts.eventTypes ?? [] } });
    }
    if (body.query.includes("ChangeCurrentTeam")) {
      const team = opts.currentTeam ?? {
        id: body.variables.team,
        name: "Team",
      };
      return json({ data: { ChangeCurrentTeam: { team } } });
    }
    if (body.query.includes("CreateActivity")) {
      return json({
        data: { CreateActivity: { activity: opts.created ?? null } },
      });
    }
    if (body.query.includes("UpdateActivity")) {
      return json({
        data: { UpdateActivity: { activity: opts.updated ?? null } },
      });
    }
    // The for-edit read also matches "activity(id:" — dispatch on its
    // distinctive field first.
    if (body.query.includes("is_repeated_activity")) {
      return json({ data: { activity: opts.editActivity ?? null } });
    }
    if (body.query.includes("activities_page")) {
      return json({
        data: {
          activities_page: {
            current_page: 0,
            activities_groups: opts.activityGroups ?? [],
          },
        },
      });
    }
    if (body.query.includes("activity(id:")) {
      return json({ data: { activity: opts.activity ?? null } });
    }
    return json({});
  });
  return {
    signIns: () => requests.filter((r) => r.query.includes("SignIn")).length,
    requests: () => requests,
  };
}

describe("HoldsportClient chat (GraphQL)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearChatTokenCache(); // the token cache is process-level; isolate each test
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("signs in once, then shapes + sorts rooms by last-message time desc", async () => {
    const spy = stubGraphql();
    const client = new HoldsportClient(chatConfig);
    const rooms = await client.listChatRooms();

    expect(spy.signIns()).toBe(1);
    expect(rooms.map((r) => r.id)).toEqual([10, 11, 12]); // 12 (no message) last
    expect(rooms[0]).toEqual({
      id: 10,
      name: "Team chat",
      scope: "team",
      unread_count: 2,
      last_message: {
        author: "Bo Berg",
        text: "see you",
        time: "2025-01-10T18:00:00+01:00",
      },
      activity: null,
    });
    expect(rooms[1].activity).toEqual({ id: 555, name: "Match" });
    expect(rooms[2].last_message).toBeNull();
  });

  it("merges team-scoped rooms with ad-hoc rooms, deduped by id", async () => {
    stubGraphql({
      rooms: [CHAT_ROOMS[0]], // room 10, scope rooms_users
      teams: [
        {
          id: 100,
          chat_rooms_scoped: [
            {
              id: 20,
              name: "Hold-chat",
              scope: "team",
              unread_count: 0,
              activity: null,
              latest_chat_message: {
                text: "hi team",
                created_at: { iso8601: "2025-01-11T09:00:00+01:00" },
                user: { name: "Coach" },
              },
            },
            // Same id as the ad-hoc room 10 — must be dropped as a duplicate.
            {
              id: 10,
              name: "dup",
              scope: "team",
              unread_count: 0,
              activity: null,
              latest_chat_message: null,
            },
          ],
        },
      ],
    });
    const rooms = await new HoldsportClient(chatConfig).listChatRooms();
    expect(rooms.map((r) => r.id)).toEqual([20, 10]); // team room (Jan 11) before room 10 (Jan 10)
    expect(rooms.find((r) => r.id === 10)!.name).toBe("Team chat"); // ad-hoc copy kept, not "dup"
  });

  it("sends the SignIn token as a raw Authorization header on the query", async () => {
    const spy = stubGraphql();
    await new HoldsportClient(chatConfig).listChatRooms();
    const query = spy
      .requests()
      .find((r) => r.query.includes("rooms_users_chat_rooms"));
    expect(query?.auth).toBe("tok-123"); // raw token, no "Bearer " prefix
  });

  it("memoizes the token across calls (one SignIn for two reads)", async () => {
    const spy = stubGraphql({
      room: {
        id: 10,
        name: "r",
        scope: "team",
        unread_count: 0,
        chat_messages: [],
      },
    });
    const client = new HoldsportClient(chatConfig);
    await client.listChatRooms();
    await client.chatRoom(10);
    expect(spy.signIns()).toBe(1);
  });

  it("caches across client instances but keys by username", async () => {
    const spy = stubGraphql();
    // Two distinct logins each sign in; reusing a login hits the shared cache.
    await new HoldsportClient({
      ...chatConfig,
      username: "alice",
    }).listChatRooms();
    await new HoldsportClient({
      ...chatConfig,
      username: "bob",
    }).listChatRooms();
    await new HoldsportClient({
      ...chatConfig,
      username: "alice",
    }).listChatRooms();
    expect(spy.signIns()).toBe(2); // alice + bob; the second alice is a cache hit
  });

  it("shapes a room's messages oldest-first with image urls", async () => {
    stubGraphql({
      room: {
        id: 10,
        name: "Team chat",
        scope: "team",
        unread_count: 1,
        chat_messages: CHAT_MESSAGES,
      },
    });
    const room = await new HoldsportClient(chatConfig).chatRoom("10");
    expect(room.messages.map((m) => m.id)).toEqual([1, 2, 3]); // sorted by to_i
    expect(room.messages[0]).toEqual({
      id: 1,
      time: "2025-01-10T10:00:00+01:00",
      author: "Bo Berg",
      text: "first",
      images: ["https://img/1"],
    });
    expect(room.messages[1].text).toBe("second\nline");
  });

  it("trims to the most recent N but keeps chronological order", async () => {
    stubGraphql({
      room: {
        id: 10,
        name: "r",
        scope: "team",
        unread_count: 0,
        chat_messages: CHAT_MESSAGES,
      },
    });
    const room = await new HoldsportClient(chatConfig).chatRoom("10", 2);
    expect(room.messages.map((m) => m.id)).toEqual([2, 3]); // newest two, in order
  });

  it("throws a clear error on the empty-{} gate response", async () => {
    stubFetch(() => json({}));
    await expect(
      new HoldsportClient(chatConfig).listChatRooms(),
    ).rejects.toThrow(/no data|X-App-Version/);
  });

  it("surfaces GraphQL errors", async () => {
    stubFetch(() => json({ errors: [{ message: "nope" }] }));
    await expect(
      new HoldsportClient(chatConfig).listChatRooms(),
    ).rejects.toThrow(/GraphQL error: nope/);
  });

  it("throws when SignIn returns no token", async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("SignIn")) return json({ data: { SignIn: {} } });
      return json({ data: {} });
    });
    await expect(
      new HoldsportClient(chatConfig).listChatRooms(),
    ).rejects.toThrow(/no access_token/);
  });
});

const INBOX = [
  {
    id: 11,
    subject: "Older notice ",
    has_been_read: true,
    created_at: { iso8601: "2025-01-09T10:00:00+01:00" },
    sender: { id: 5, name: "Coach Bo" },
    attachment1_name: null,
  },
  {
    id: 12,
    subject: "Newest, with file",
    has_been_read: false,
    created_at: { iso8601: "2025-01-12T08:00:00+01:00" },
    sender: { id: 6, name: "Admin Ann" },
    attachment1_name: "agenda.pdf",
  },
];

describe("HoldsportClient email (GraphQL)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearChatTokenCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("shapes the inbox newest-first with read + attachment flags", async () => {
    stubGraphql({ received: INBOX });
    const emails = await new HoldsportClient(chatConfig).listEmails();
    expect(emails.map((e) => e.id)).toEqual([12, 11]); // newest first
    expect(emails[0]).toEqual({
      id: 12,
      subject: "Newest, with file",
      sender: "Admin Ann",
      time: "2025-01-12T08:00:00+01:00",
      has_been_read: false,
      has_attachments: true,
    });
    expect(emails[1].has_attachments).toBe(false);
  });

  it("reads the sent box when sent:true", async () => {
    const spy = stubGraphql({ sent: [INBOX[0]] });
    const emails = await new HoldsportClient(chatConfig).listEmails({
      sent: true,
    });
    expect(emails).toHaveLength(1);
    expect(spy.requests().some((r) => r.query.includes("sent_emails"))).toBe(
      true,
    );
  });

  it("limits to the most recent N", async () => {
    stubGraphql({ received: INBOX });
    const emails = await new HoldsportClient(chatConfig).listEmails({
      limit: 1,
    });
    expect(emails.map((e) => e.id)).toEqual([12]);
  });

  it("shapes a single email with recipients and non-empty attachments", async () => {
    stubGraphql({
      email: {
        id: 12,
        subject: "Newest",
        content: "Hello team",
        has_been_read: false,
        created_at: { iso8601: "2025-01-12T08:00:00+01:00" },
        sender: { id: 6, name: "Admin Ann" },
        recipients: [
          { id: 1, name: "Bo Berg" },
          { id: 2, name: "Cy Cohen" },
        ],
        attachment1_name: "agenda.pdf",
        attachment1_url: "https://files/agenda.pdf",
        attachment2_name: null,
        attachment2_url: null,
        attachment3_name: null,
        attachment3_url: null,
      },
    });
    const email = await new HoldsportClient(chatConfig).getEmail("12");
    expect(email.content).toBe("Hello team");
    expect(email.recipients).toEqual(["Bo Berg", "Cy Cohen"]);
    expect(email.attachments).toEqual([
      { name: "agenda.pdf", url: "https://files/agenda.pdf" },
    ]);
  });

  it("throws when the email is not found", async () => {
    stubGraphql({ email: null });
    await expect(new HoldsportClient(chatConfig).getEmail(999)).rejects.toThrow(
      /email 999 not found/,
    );
  });
});

describe("HoldsportClient activities (GraphQL)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearChatTokenCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("flattens the activity groups and shapes + sorts rows by time", async () => {
    const spy = stubGraphql({
      activityGroups: [
        {
          activities: [
            {
              id: 2,
              name: "Match",
              place: "Away",
              is_cancelled: true,
              starttime: { iso8601: "2026-06-05T18:00:00+02:00" },
              endtime: { iso8601: "2026-06-05T20:00:00+02:00" },
              event_type: { name: "Kamp" },
              attendee_count: 12,
      max_attendees: null,
      has_waiting_list: false,
      registration_deadline: "",
            },
          ],
        },
        {
          activities: [
            {
              id: 1,
              name: "Træning ",
              place: "Hallen",
              pickup_time: "15:45",
              is_cancelled: false,
              starttime: { iso8601: "2026-06-04T16:10:00+02:00" },
              endtime: { iso8601: "2026-06-04T17:40:00+02:00" },
              event_type: { name: "Træning" },
              attendee_count: 22,
      max_attendees: null,
      has_waiting_list: false,
      registration_deadline: "",
            },
          ],
        },
      ],
    });
    const rows = await new HoldsportClient(chatConfig).listActivities({
      teamId: "37141",
      date: "2026-06-03",
    });
    expect(rows.map((r) => r.id)).toEqual([1, 2]); // sorted by time, across groups
    expect(rows[0]).toEqual({
      id: 1,
      name: "Træning",
      time: "2026-06-04T16:10:00+02:00",
      end_time: "2026-06-04T17:40:00+02:00",
      place: "Hallen",
      meeting_time: "15:45",
      event_type: "Træning",
      is_cancelled: false,
      attendee_count: 22,
      max_attendees: null,
      has_waiting_list: false,
      registration_deadline: "",
      teams: [],
    });
    expect(rows[1].is_cancelled).toBe(true);
    expect(rows[1].meeting_time).toBe(""); // no pickup_time in the fixture
    // the paginated activities query was issued, reading the date-filtered
    // `activities_groups` (not the now-cutoff `future_activities_groups`)
    const req = spy.requests().find((r) => r.query.includes("activities_page"));
    expect(req?.query).toContain("activities_groups");
    expect(req?.query).not.toContain("future_activities_groups");
    // page defaults to the server's first page, which is 0-indexed
    expect(req?.variables.page).toBe(0);
  });

  it("maps the caller's 1-based page onto the server's 0-based page", async () => {
    const spy = stubGraphql({ activityGroups: [] });
    await new HoldsportClient(chatConfig).listActivities({
      teamId: "37141",
      page: 2,
    });
    const req = spy.requests().find((r) => r.query.includes("activities_page"));
    expect(req?.variables.page).toBe(1);
  });

  it("shapes the attendance breakdown and counts", async () => {
    stubGraphql({
      activity: {
        id: 7,
        name: "Sommertræning",
        place: "Rødovre",
        comment: "Husk drikkedunk",
        is_cancelled: false,
        starttime: { iso8601: "2026-06-04T16:10:00+02:00" },
        endtime: { iso8601: "2026-06-04T17:40:00+02:00" },
        event_type: { name: "Træning" },
        type: 1,
        attendee_count: 3,
    max_attendees: null,
    has_waiting_list: false,
    registration_deadline: "",
        player_count: 2,
        coach_count: 1,
        max_attender: 999,
        attending_players: [{ name: "Bo Berg #6" }, { name: "Cy Cohen " }],
        attending_coaches: [{ name: "Coach Ann" }],
        non_attendees: [{ name: "Dee Day" }],
        users_with_no_rsvp: [],
        wait_list_entries: [{ id: 1 }, { id: 2 }],
        custom_tasks: [{ id: 9 }],
      },
    });
    const a = await new HoldsportClient(chatConfig).getActivity("7");
    expect(a.counts).toEqual({
      attending: 3,
      players: 2,
      coaches: 1,
      // 999 is Holdsport's "no limit" sentinel, normalised here as it is in
      // the summary — otherwise the same activity reads "50 of 999" from the
      // detail tool and "50" from the list one.
      max: 0,
    });
    expect(a.attendance.attending_players).toEqual(["Bo Berg #6", "Cy Cohen"]);
    expect(a.attendance.attending_coaches).toEqual(["Coach Ann"]);
    expect(a.attendance.not_attending).toEqual(["Dee Day"]);
    expect(a.attendance.no_answer).toEqual([]);
    expect(a.waiting_list).toBe(2);
    expect(a.tasks).toBe(1);
    expect(a.comment).toBe("Husk drikkedunk");
    expect(a.registration_type).toBe("pick_out");
  });

  it("surfaces an unknown registration-type code as the bare number", async () => {
    stubGraphql({ activity: { id: 7, type: 42 } });
    const a = await new HoldsportClient(chatConfig).getActivity("7");
    expect(a.registration_type).toBe("42");
  });

  it("throws when the activity is not found", async () => {
    stubGraphql({ activity: null });
    await expect(
      new HoldsportClient(chatConfig).getActivity(404),
    ).rejects.toThrow(/activity 404 not found/);
  });

  it("lists a team's event types, passing the team id as a number", async () => {
    const spy = stubGraphql({
      eventTypes: [
        { id: 3, name: "Træning ", color: "#00ff00" },
        { id: 4, name: "Kamp", color: "#ff0000" },
      ],
    });
    const types = await new HoldsportClient(chatConfig).listEventTypes();
    expect(types).toEqual([
      { id: 3, name: "Træning", color: "#00ff00" },
      { id: 4, name: "Kamp", color: "#ff0000" },
    ]);
    const req = spy
      .requests()
      .find((r) => r.query.includes("activities_event_types"));
    expect(req?.variables.team).toBe(99); // config teamId "99", as an Int
  });
});

// --- Creating activities (GraphQL, the one write path) ---------------------

const CREATED_ACTIVITY = {
  id: 900,
  name: "Ekstra træning ",
  place: "Hallen",
  pickup_time: "16:40",
  is_cancelled: false,
  starttime: { iso8601: "2026-08-10T17:00:00+02:00" },
  endtime: { iso8601: "2026-08-10T18:30:00+02:00" },
  event_type: { name: "Træning" },
  attendee_count: 0,
};

const NEW_ACTIVITY = {
  name: "Ekstra træning",
  date: "2026-08-10",
  start_time: "17:00",
  end_time: "18:30",
  meeting_time: "16:40",
  place: "Hallen",
  comment: "Medbring bold",
  event_type_id: 3,
  max_attendees: 20,
};

describe("HoldsportClient.createActivity", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearChatTokenCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("switches to the team, verifies it, then creates with the mapped input", async () => {
    const spy = stubGraphql({ created: CREATED_ACTIVITY });
    const created = await new HoldsportClient(chatConfig).createActivity(
      NEW_ACTIVITY,
    );

    // The switch targets the configured team and precedes the create.
    const ops = spy.requests().map((r) => r.query);
    const switchAt = ops.findIndex((q) => q.includes("ChangeCurrentTeam"));
    const createAt = ops.findIndex((q) => q.includes("CreateActivity"));
    expect(switchAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(switchAt);
    expect(spy.requests()[switchAt].variables.team).toBe(99);

    // The CLI fields map onto the mutation's input names.
    expect(spy.requests()[createAt].variables.input).toEqual({
      name: "Ekstra træning",
      // Date + time combined: the resolvers parse start_time/end_time as full
      // datetimes and ignore the separate date input fields.
      start_time: "2026-08-10 17:00",
      end_time: "2026-08-10 18:30",
      pickup_time: "16:40",
      place: "Hallen",
      comment: "Medbring bold",
      event_type_id: 3,
      max_number_of_attendees: 20,
    });

    // The server's echo comes back shaped like a list row.
    expect(created).toEqual({
      id: 900,
      name: "Ekstra træning",
      time: "2026-08-10T17:00:00+02:00",
      end_time: "2026-08-10T18:30:00+02:00",
      place: "Hallen",
      meeting_time: "16:40",
      event_type: "Træning",
      is_cancelled: false,
      attendee_count: 0,
      max_attendees: null,
      has_waiting_list: false,
      registration_deadline: "",
      teams: [],
    });
  });

  it("omits optional fields it wasn't given", async () => {
    const spy = stubGraphql({ created: CREATED_ACTIVITY });
    await new HoldsportClient(chatConfig).createActivity({
      name: "Kort",
      date: "2026-08-10",
      start_time: "17:00",
    });
    const req = spy.requests().find((r) => r.query.includes("CreateActivity"));
    expect(req?.variables.input).toEqual({
      name: "Kort",
      start_time: "2026-08-10 17:00",
    });
  });

  it("maps registration_type onto the mutation's activity_type code", async () => {
    const spy = stubGraphql({ created: CREATED_ACTIVITY });
    await new HoldsportClient(chatConfig).createActivity({
      name: "Udtagelseskamp",
      date: "2026-08-10",
      start_time: "17:00",
      registration_type: "pick_out",
    });
    const req = spy.requests().find((r) => r.query.includes("CreateActivity"));
    expect(req?.variables.input.activity_type).toBe(1);
    expect(req?.variables.input.registration_type).toBeUndefined();
  });

  it("puts a multi-day end date into the combined end datetime", async () => {
    const spy = stubGraphql({ created: CREATED_ACTIVITY });
    await new HoldsportClient(chatConfig).createActivity({
      name: "Tur",
      date: "2026-08-10",
      start_time: "17:00",
      end_time: "09:00",
      end_date: "2026-08-11",
    });
    const req = spy.requests().find((r) => r.query.includes("CreateActivity"));
    expect(req?.variables.input.start_time).toBe("2026-08-10 17:00");
    expect(req?.variables.input.end_time).toBe("2026-08-11 09:00");
  });

  it("refuses to create when the server lands on a different team", async () => {
    const spy = stubGraphql({
      currentTeam: { id: 123, name: "Wrong team" },
      created: CREATED_ACTIVITY,
    });
    await expect(
      new HoldsportClient(chatConfig).createActivity(NEW_ACTIVITY),
    ).rejects.toThrow(/refusing to write.*123/);
    // Nothing was written: the create mutation was never sent.
    expect(spy.requests().some((r) => r.query.includes("CreateActivity"))).toBe(
      false,
    );
  });

  it("rejects malformed dates/times before any request is sent", async () => {
    const spy = stubGraphql();
    const client = new HoldsportClient(chatConfig);
    await expect(
      client.createActivity({ ...NEW_ACTIVITY, date: "10/08/2026" }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      client.createActivity({ ...NEW_ACTIVITY, start_time: "5pm" }),
    ).rejects.toThrow(/HH:MM/);
    await expect(
      client.createActivity({ ...NEW_ACTIVITY, meeting_time: "9.05" }),
    ).rejects.toThrow(/meeting time.*HH:MM/);
    await expect(
      client.createActivity({ ...NEW_ACTIVITY, end_time: "16:00" }),
    ).rejects.toThrow(/not after start/);
    await expect(
      client.createActivity({ ...NEW_ACTIVITY, name: "  " }),
    ).rejects.toThrow(/name/);
    await expect(
      client.createActivity({
        ...NEW_ACTIVITY,
        registration_type: "vip" as never,
      }),
    ).rejects.toThrow(/registration type must be one of/);
    expect(spy.requests()).toHaveLength(0);
  });

  it("allows an earlier end time when the activity ends on a later day", async () => {
    stubGraphql({ created: CREATED_ACTIVITY });
    await expect(
      new HoldsportClient(chatConfig).createActivity({
        ...NEW_ACTIVITY,
        end_time: "09:00",
        end_date: "2026-08-11",
      }),
    ).resolves.toBeDefined();
  });

  it("throws when CreateActivity echoes no activity back", async () => {
    stubGraphql({ created: null });
    await expect(
      new HoldsportClient(chatConfig).createActivity(NEW_ACTIVITY),
    ).rejects.toThrow(/returned no activity/);
  });
});

// A real-world-shaped for-edit read: the API hands back UTC instants (`Z`),
// which the editable fields must convert to Danish wall clock.
const EDIT_ACTIVITY = {
  id: 55934876,
  name: "Træning U16",
  place: "Arenaen",
  comment: "Fys 9.15",
  pickup_time: "09:05",
  starttime: { iso8601: "2026-08-09T08:45:00Z" }, // 10:45 Danish summer time
  endtime: { iso8601: "2026-08-09T10:15:00Z" }, // 12:15
  event_type: { id: 2 },
  max_attender: 999,
  teams: [{ id: 37141, name: "RSIK U16" }],
  is_repeated_activity: false,
  is_root_of_repeated_activities: false,
  has_future_repeated_activities: false,
  // Server-assigned fields that must be echoed back on update (values as a
  // real activity returns them: booleans/ints non-null, unused fields null).
  is_payment_activity: false,
  type: 3,
  reminder2: 0,
  reminder5: 0,
  hide_unattend: false,
  ride_enabled: false,
  ride_comment: null,
  only_player_participation_counts: false,
  has_waiting_list: false,
  hide_activity_players_registration: false,
  pickup_place: null,
  points: null,
  rating: null,
  is_club_activity: false,
  absolute_registration_deadline: null,
  registration_start_at: null,
};

/**
 * The passthrough echo expected from EDIT_ACTIVITY (nulls omitted). Its
 * `type: 3` is NOT here: a known registration-type code surfaces as the
 * editable `registration_type` field and reaches the update input through
 * activityInput instead.
 */
const EDIT_PASSTHROUGH = {
  reminder2: 0,
  reminder5: 0,
  hide_unattend: false,
  ride: false,
  only_player_participation_counts: false,
  has_waiting_list: false,
  hide_activity_players_registration: false,
};

describe("HoldsportClient.updateActivity", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearChatTokenCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("reads the editable fields back in Danish wall-clock time", async () => {
    stubGraphql({ editActivity: EDIT_ACTIVITY });
    const a = await new HoldsportClient(chatConfig).activityForEdit(55934876);
    expect(a).toEqual({
      id: 55934876,
      team: { id: 37141, name: "RSIK U16" },
      is_repeated: false,
      is_payment: false,
      passthrough: EDIT_PASSTHROUGH,
      fields: {
        name: "Træning U16",
        date: "2026-08-09",
        start_time: "10:45", // 08:45Z shown as Danish summer time
        end_time: "12:15",
        end_date: "2026-08-09",
        meeting_time: "09:05", // pickup_time is already wall clock
        event_type_id: 2,
        place: "Arenaen",
        comment: "Fys 9.15",
        max_attendees: 999,
        registration_type: "everybody_attending", // type: 3, mapped to its name
      },
    });
  });

  it("converts winter instants with the +01:00 offset", async () => {
    stubGraphql({
      editActivity: {
        ...EDIT_ACTIVITY,
        starttime: { iso8601: "2026-01-15T17:00:00Z" },
        endtime: null,
      },
    });
    const a = await new HoldsportClient(chatConfig).activityForEdit(55934876);
    expect(a.fields.date).toBe("2026-01-15");
    expect(a.fields.start_time).toBe("18:00");
    expect(a.fields.end_time).toBeUndefined();
    expect(a.fields.end_date).toBeUndefined();
  });

  it("merges changes over the current fields and sends the full set to the activity's own team", async () => {
    const spy = stubGraphql({
      editActivity: EDIT_ACTIVITY,
      updated: CREATED_ACTIVITY,
    });
    await new HoldsportClient(chatConfig).updateActivity(55934876, {
      start_time: "11:00",
      end_time: "12:30",
    });

    // Switched to the activity's owning team — not the configured team 99.
    const switchReq = spy
      .requests()
      .find((r) => r.query.includes("ChangeCurrentTeam"));
    expect(switchReq?.variables.team).toBe(37141);

    // The full merged field set goes out, so paired fields (date + time) that
    // the server may recombine never arrive half-updated.
    const req = spy.requests().find((r) => r.query.includes("UpdateActivity"));
    expect(req?.variables.input).toEqual({
      id: 55934876,
      name: "Træning U16",
      // The update resolver parses start_time/end_time as full datetimes and
      // ignores the separate date fields, so date + time arrive combined.
      start_time: "2026-08-09 11:00",
      end_time: "2026-08-09 12:30",
      pickup_time: "09:05", // untouched fields ride along unchanged
      event_type_id: 2,
      place: "Arenaen",
      comment: "Fys 9.15",
      max_number_of_attendees: 999,
      activity_type: 3, // the unchanged registration type still goes out
      // The server NULLs any omitted input field, so the non-editable fields
      // must be echoed back verbatim.
      ...EDIT_PASSTHROUGH,
    });
  });

  it("changes the registration type when asked", async () => {
    const spy = stubGraphql({
      editActivity: EDIT_ACTIVITY,
      updated: CREATED_ACTIVITY,
    });
    await new HoldsportClient(chatConfig).updateActivity(55934876, {
      registration_type: "pick_out",
    });
    const req = spy.requests().find((r) => r.query.includes("UpdateActivity"));
    expect(req?.variables.input.activity_type).toBe(1); // was 3
  });

  it("echoes an unknown registration-type code back verbatim", async () => {
    // A code this client predates must survive an unrelated edit untouched.
    const spy = stubGraphql({
      editActivity: { ...EDIT_ACTIVITY, type: 42 },
      updated: CREATED_ACTIVITY,
    });
    const a = await new HoldsportClient(chatConfig).activityForEdit(55934876);
    expect(a.fields.registration_type).toBeUndefined();
    expect(a.passthrough.activity_type).toBe(42);
    await new HoldsportClient(chatConfig).updateActivity(55934876, {
      name: "Ny",
    });
    const req = spy.requests().find((r) => r.query.includes("UpdateActivity"));
    expect(req?.variables.input.activity_type).toBe(42);
  });

  it("ignores undefined change values instead of clobbering fields", async () => {
    const spy = stubGraphql({
      editActivity: EDIT_ACTIVITY,
      updated: CREATED_ACTIVITY,
    });
    await new HoldsportClient(chatConfig).updateActivity(55934876, {
      name: "Ny titel",
      place: undefined,
    });
    const req = spy.requests().find((r) => r.query.includes("UpdateActivity"));
    expect(req?.variables.input.name).toBe("Ny titel");
    expect(req?.variables.input.place).toBe("Arenaen"); // kept, not cleared
  });

  it("treats an empty pickup_time as unset and does not echo it back", async () => {
    // The API returns "" as well as null for "no meeting time".
    const spy = stubGraphql({
      editActivity: { ...EDIT_ACTIVITY, pickup_time: "" },
      updated: CREATED_ACTIVITY,
    });
    const a = await new HoldsportClient(chatConfig).activityForEdit(55934876);
    expect(a.fields.meeting_time).toBeUndefined();
    await new HoldsportClient(chatConfig).updateActivity(55934876, {
      name: "Ny",
    });
    const req = spy.requests().find((r) => r.query.includes("UpdateActivity"));
    expect(req?.variables.input).not.toHaveProperty("pickup_time");
  });

  it("throws when no changes are given, before any request", async () => {
    const spy = stubGraphql();
    const client = new HoldsportClient(chatConfig);
    await expect(client.updateActivity(1, {})).rejects.toThrow(
      /nothing to change/,
    );
    await expect(client.updateActivity(1, { name: undefined })).rejects.toThrow(
      /nothing to change/,
    );
    expect(spy.requests()).toHaveLength(0);
  });

  it("refuses a repeated activity when no repeat scope is given", async () => {
    const spy = stubGraphql({
      editActivity: { ...EDIT_ACTIVITY, is_repeated_activity: true },
      updated: CREATED_ACTIVITY,
    });
    await expect(
      new HoldsportClient(chatConfig).updateActivity(55934876, { name: "Ny" }),
    ).rejects.toThrow(/repeating/);
    expect(spy.requests().some((r) => r.query.includes("UpdateActivity"))).toBe(
      false,
    );
  });

  it("detects a series ROOT as repeated even though is_repeated_activity is false", async () => {
    // Verified live: the first activity of a series reports
    // is_repeated_activity: false and only flags is_root_of_repeated_activities.
    for (const flag of [
      "is_root_of_repeated_activities",
      "has_future_repeated_activities",
    ]) {
      stubGraphql({
        editActivity: { ...EDIT_ACTIVITY, [flag]: true },
        updated: CREATED_ACTIVITY,
      });
      await expect(
        new HoldsportClient(chatConfig).updateActivity(55934876, {
          name: "Ny",
        }),
      ).rejects.toThrow(/repeating/);
    }
  });

  it('maps repeat scope "this" / "future" onto update_current_and_future', async () => {
    for (const [scope, sent] of [
      ["this", false],
      ["future", true],
    ] as const) {
      const spy = stubGraphql({
        editActivity: { ...EDIT_ACTIVITY, is_repeated_activity: true },
        updated: CREATED_ACTIVITY,
      });
      await new HoldsportClient(chatConfig).updateActivity(
        55934876,
        { name: "Ny" },
        { repeatScope: scope },
      );
      const req = spy
        .requests()
        .find((r) => r.query.includes("UpdateActivity"));
      expect(req?.variables.input.update_current_and_future).toBe(sent);
    }
  });

  it("never sends update_current_and_future for a non-repeated activity", async () => {
    // Even if a caller passes a scope, a one-off activity must not carry the
    // series flag — the merge test above also guards this via its exact
    // toEqual on the input.
    const spy = stubGraphql({
      editActivity: EDIT_ACTIVITY,
      updated: CREATED_ACTIVITY,
    });
    await new HoldsportClient(chatConfig).updateActivity(
      55934876,
      { name: "Ny" },
      { repeatScope: "future" },
    );
    const req = spy.requests().find((r) => r.query.includes("UpdateActivity"));
    expect(req?.variables.input).not.toHaveProperty(
      "update_current_and_future",
    );
  });

  it("refuses to edit a payment activity", async () => {
    const spy = stubGraphql({
      editActivity: { ...EDIT_ACTIVITY, is_payment_activity: true },
      updated: CREATED_ACTIVITY,
    });
    await expect(
      new HoldsportClient(chatConfig).updateActivity(55934876, { name: "Ny" }),
    ).rejects.toThrow(/payment activity/);
    expect(spy.requests().some((r) => r.query.includes("UpdateActivity"))).toBe(
      false,
    );
  });

  it("echoes registration windows as wall-clock date + time pairs", async () => {
    const spy = stubGraphql({
      editActivity: {
        ...EDIT_ACTIVITY,
        absolute_registration_deadline: { iso8601: "2026-08-08T18:00:00Z" },
        registration_start_at: { iso8601: "2026-08-01T06:00:00Z" },
        ride_comment: "Samkørsel fra hallen",
      },
      updated: CREATED_ACTIVITY,
    });
    await new HoldsportClient(chatConfig).updateActivity(55934876, {
      name: "Ny",
    });
    const input = spy.requests().find((r) => r.query.includes("UpdateActivity"))
      ?.variables.input;
    expect(input.absolute_registration_deadline_date).toBe("2026-08-08");
    expect(input.absolute_registration_deadline_time).toBe("20:00"); // 18:00Z, Danish summer
    expect(input.registration_start_date).toBe("2026-08-01");
    expect(input.registration_start_time).toBe("08:00");
    expect(input.ride_comment).toBe("Samkørsel fra hallen");
  });

  it("refuses when the owning team is unknown", async () => {
    stubGraphql({ editActivity: { ...EDIT_ACTIVITY, teams: [] } });
    await expect(
      new HoldsportClient(chatConfig).updateActivity(55934876, { name: "Ny" }),
    ).rejects.toThrow(/owning team/);
  });

  it("validates the merged result before writing", async () => {
    const spy = stubGraphql({ editActivity: EDIT_ACTIVITY });
    // 09:00 is before the activity's (unchanged) 10:45 start.
    await expect(
      new HoldsportClient(chatConfig).updateActivity(55934876, {
        end_time: "09:00",
      }),
    ).rejects.toThrow(/not after start/);
    const wrote = spy
      .requests()
      .some(
        (r) =>
          r.query.includes("UpdateActivity") ||
          r.query.includes("ChangeCurrentTeam"),
      );
    expect(wrote).toBe(false);
  });

  it("refuses when the server lands on a different team", async () => {
    const spy = stubGraphql({
      editActivity: EDIT_ACTIVITY,
      currentTeam: { id: 1, name: "Wrong" },
      updated: CREATED_ACTIVITY,
    });
    await expect(
      new HoldsportClient(chatConfig).updateActivity(55934876, { name: "Ny" }),
    ).rejects.toThrow(/refusing to write/);
    expect(spy.requests().some((r) => r.query.includes("UpdateActivity"))).toBe(
      false,
    );
  });

  it("throws when the activity is not found", async () => {
    stubGraphql({ editActivity: null });
    await expect(
      new HoldsportClient(chatConfig).updateActivity(404, { name: "Ny" }),
    ).rejects.toThrow(/activity 404 not found/);
  });

  it("throws when UpdateActivity echoes no activity back", async () => {
    stubGraphql({ editActivity: EDIT_ACTIVITY, updated: null });
    await expect(
      new HoldsportClient(chatConfig).updateActivity(55934876, { name: "Ny" }),
    ).rejects.toThrow(/returned no activity/);
  });
});

describe("activitiesInRange", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  /** A minimal GraphQL row; `start` is an ISO instant. */
  const row = (id: number, start: string) => ({
    id,
    name: `A${id}`,
    place: "Hallen",
    is_cancelled: false,
    starttime: { iso8601: start },
    endtime: { iso8601: start },
    event_type: { name: "Træning" },
    attendee_count: 1,
  });

  /**
   * Serve `pages[n]` for the 0-based page the client asks for; anything past
   * the end comes back empty, like the real server.
   */
  function stubPages(pages: unknown[][]): { pageArgs: () => number[] } {
    const pageArgs: number[] = [];
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes("SignIn")) {
        return json({ data: { SignIn: { access_token: "tok-123" } } });
      }
      const page = body.variables.page as number;
      pageArgs.push(page);
      return json({
        data: {
          activities_page: {
            current_page: page,
            activities_groups: [{ activities: pages[page] ?? [] }],
          },
        },
      });
    });
    return { pageArgs: () => pageArgs };
  }

  it("stops at the first empty page", async () => {
    const { pageArgs } = stubPages([
      [row(1, "2026-06-04T16:00:00+02:00")],
      [],
      [row(3, "2026-06-06T16:00:00+02:00")],
    ]);
    const rows = await new HoldsportClient(chatConfig).activitiesInRange({
      teamId: "37141",
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(pageArgs()).toEqual([0, 1]); // never asked for page 2
  });

  it("stops paging once a page has passed the window, and drops later rows", async () => {
    const { pageArgs } = stubPages([
      [row(1, "2026-06-04T16:00:00+02:00")],
      [row(2, "2026-06-09T16:00:00+02:00"), row(3, "2026-06-20T16:00:00+02:00")],
      [row(4, "2026-06-21T16:00:00+02:00")],
    ]);
    const rows = await new HoldsportClient(chatConfig).activitiesInRange({
      teamId: "37141",
      from: "2026-06-01",
      to: "2026-06-10",
    });
    // 3 is past `to` so it is dropped, and its page ends the walk.
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(pageArgs()).toEqual([0, 1]);
  });

  it("keeps a late-evening activity on the final day of the window", async () => {
    // 23:30 Copenhagen on 30 June is 21:30Z the same day — but a 00:30 activity
    // would be 22:30Z on the 29th. Both must be judged by the Danish calendar
    // day, which is what a person means by "up to the 30th".
    stubPages([
      [
        row(1, "2026-06-30T23:30:00+02:00"),
        row(2, "2026-07-01T00:30:00+02:00"),
      ],
    ]);
    const rows = await new HoldsportClient(chatConfig).activitiesInRange({
      teamId: "37141",
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("de-duplicates activities repeated across pages", async () => {
    stubPages([
      [row(1, "2026-06-04T16:00:00+02:00"), row(2, "2026-06-05T16:00:00+02:00")],
      [row(2, "2026-06-05T16:00:00+02:00"), row(3, "2026-06-06T16:00:00+02:00")],
      [],
    ]);
    const rows = await new HoldsportClient(chatConfig).activitiesInRange({
      teamId: "37141",
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("refuses rather than returning a list truncated at maxPages", async () => {
    const endless = Array.from({ length: 20 }, (_, i) => [
      row(i + 1, "2026-06-04T16:00:00+02:00"),
    ]);
    const { pageArgs } = stubPages(endless);
    // A partial list is indistinguishable from a complete one, and a caller
    // would report "nothing scheduled" for a window it never reached.
    await expect(
      new HoldsportClient(chatConfig).activitiesInRange({
        teamId: "37141",
        from: "2026-06-01",
        to: "2026-12-31",
        maxPages: 3,
      }),
    ).rejects.toThrow(/stopped at the 3-page limit/);
    expect(pageArgs()).toEqual([0, 1, 2]);
  });

  it("rejects a date that is not zero-padded", async () => {
    // Days are compared as strings, so "2026-6-30" would never match and the
    // window would never close — burning every page and returning months of
    // activities outside the range, with no error.
    stubPages([[row(1, "2026-06-04T16:00:00+02:00")]]);
    await expect(
      new HoldsportClient(chatConfig).activitiesInRange({
        teamId: "37141",
        from: "2026-06-01",
        to: "2026-6-30",
      }),
    ).rejects.toThrow(/to must be YYYY-MM-DD/);
  });

  it("rejects a maxPages that would fetch nothing", async () => {
    stubPages([[row(1, "2026-06-04T16:00:00+02:00")]]);
    await expect(
      new HoldsportClient(chatConfig).activitiesInRange({
        teamId: "37141",
        maxPages: 0,
      }),
    ).rejects.toThrow(/maxPages must be a positive whole number/);
  });

  it("returns everything when no end date is given", async () => {
    stubPages([[row(1, "2027-06-04T16:00:00+02:00")], []]);
    const rows = await new HoldsportClient(chatConfig).activitiesInRange({
      teamId: "37141",
      from: "2026-06-01",
    });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("carries the owning team name onto each row", async () => {
    stubPages([
      [
        { ...row(1, "2026-06-04T16:00:00+02:00"), teams: [{ id: 9, name: "U13" }] },
        {
          ...row(2, "2026-06-05T16:00:00+02:00"),
          teams: [{ id: 9, name: "U13" }, { id: 8, name: " U15 " }],
        },
        row(3, "2026-06-06T16:00:00+02:00"),
      ],
      [],
    ]);
    const rows = await new HoldsportClient(chatConfig).activitiesInRange({
      teamId: "37141",
      from: "2026-06-01",
    });
    expect(rows.map((r) => (r.teams ?? []).map((t) => t.name))).toEqual([
      ["U13"],
      ["U13", "U15"],
      [],
    ]);
    expect((rows[1]?.teams ?? []).map((t) => t.id)).toEqual([9, 8]);
  });
});

describe("myAttendance", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ME = 4235495;

  /** Serve GET /user then 1-based pages of REST activities. */
  function stubRest(pages: unknown[][]): { paths: () => string[] } {
    const paths: string[] = [];
    stubFetch((url) => {
      const path = new URL(url).pathname + new URL(url).search;
      paths.push(path);
      if (path.endsWith("/user")) return json({ id: ME, firstname: "Alex" });
      const page = Number(new URL(url).searchParams.get("page"));
      return json(pages[page - 1] ?? []);
    });
    return { paths: () => paths };
  }

  /** A real action entry: the server nests the answer under activities_user. */
  const OFFERED = [{ activities_user: { joined_status: 1, name: "Tilmeld" } }];

  const act = (
    id: number,
    start: string,
    users: unknown[] = [],
    actions: unknown[] = OFFERED,
  ) => ({
    id,
    starttime: start,
    activities_users: users,
    actions,
  });

  it("reads your own row, not the activity's top-level status", async () => {
    // The case that matters: a team whose activities sign everyone up by
    // default reports status 0 at the top level while the row says Tilmeldt.
    // Trusting the top-level field would report "no answer" for someone who is
    // in fact attending. Verified against production.
    stubRest([
      [
        {
          ...act(1, "2026-06-04T16:00:00+02:00", [
            { user_id: 999, status: "Afmeldt", status_code: 2 },
            {
              user_id: ME,
              status: "Tilmeldt",
              status_code: 1,
              updated_at: "2026-05-30T10:00:00+02:00",
            },
          ]),
          status: 0,
        },
      ],
      [],
    ]);

    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(got[1]).toEqual({
      activity_id: 1,
      code: 1,
      label: "Tilmeldt",
      updated_at: "2026-05-30T10:00:00+02:00",
      can_respond: true,
      offers: [{ name: "Tilmeld", joined_status: 1 }],
    });
  });

  it("reports no answer when you have no row at all", async () => {
    stubRest([
      [act(2, "2026-06-04T16:00:00+02:00", [{ user_id: 999, status: "Tilmeldt", status_code: 1 }])],
      [],
    ]);
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
    });
    expect(got[2]).toEqual({
      activity_id: 2,
      code: -1,
      label: "",
      updated_at: "",
      can_respond: true,
      offers: [{ name: "Tilmeld", joined_status: 1 }],
    });
  });

  it("reports the answers offered, including Til rådighed", async () => {
    // A game or cup where the coach picks the squad offers "Til rådighed" (0)
    // and no Tilmeld. Filtering offers to a known 1-or-2 set is what would hide
    // it, leaving a caller to promise a sign-up the server does not accept.
    stubRest([
      [act(4, "2026-06-04T16:00:00+02:00", [], [
        { activities_user: { joined_status: 0, name: "Til rådighed" } },
        { activities_user: { joined_status: 2, name: "Afmeld" } },
      ])],
      [],
    ]);
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
    });
    expect(got[4].offers).toEqual([
      { name: "Til rådighed", joined_status: 0 },
      { name: "Afmeld", joined_status: 2 },
    ]);
    expect(got[4].can_respond).toBe(true);
  });

  it("does not count an answer with no usable code as on offer", async () => {
    // null and "" are the dangerous ones: Number() turns both into 0, which is a
    // real answer. Counted, they would report an activity answerable that
    // offers nothing a caller could submit.
    stubRest([
      [act(5, "2026-06-04T16:00:00+02:00", [], [
        { activities_user: { joined_status: null, name: "Tilmeld" } },
        { activities_user: { joined_status: "", name: "Tilmeld" } },
        { activities_user: { joined_status: "nonsense", name: "Afmeld" } },
        { activities_user: { name: "Afmeld" } },
      ])],
      [],
    ]);
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
    });
    expect(got[5].offers).toEqual([]);
    expect(got[5].can_respond).toBe(false);
  });

  it("passes an unfamiliar status through verbatim", async () => {
    // 5/"Ukendt" is a row created by rostering the whole squad, before anyone
    // has answered. The code set is open, so the server's own word is kept
    // rather than mapped to something invented.
    stubRest([
      [act(3, "2026-06-04T16:00:00+02:00", [
        { user_id: ME, status: "Ukendt", status_code: 5, updated_at: "x" },
      ])],
      [],
    ]);
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
    });
    expect(got[3].code).toBe(5);
    expect(got[3].label).toBe("Ukendt");
  });

  it("uses 1-based REST pages and stops on the first empty one", async () => {
    const { paths } = stubRest([
      [act(1, "2026-06-04T16:00:00+02:00")],
      [],
      [act(9, "2026-06-05T16:00:00+02:00")],
    ]);
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(Object.keys(got)).toEqual(["1"]);
    const activityPaths = paths().filter((p) => p.includes("/activities"));
    expect(activityPaths[0]).toContain("page=1"); // not page=0, unlike GraphQL
    expect(activityPaths).toHaveLength(2);
  });

  it("excludes activities past the window and stops once a page passes it", async () => {
    const { paths } = stubRest([
      [act(1, "2026-06-04T16:00:00+02:00"), act(2, "2026-06-20T16:00:00+02:00")],
      [act(3, "2026-06-25T16:00:00+02:00")],
    ]);
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
      to: "2026-06-10",
    });
    expect(Object.keys(got)).toEqual(["1"]);
    expect(paths().filter((p) => p.includes("/activities"))).toHaveLength(1);
  });

  it("judges the window by the Danish calendar day", async () => {
    // 00:30 on 1 July is 22:30Z on 30 June — inside the window by instant,
    // outside it by the day a person means.
    stubRest([[act(1, "2026-07-01T00:30:00+02:00")], []]);
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(Object.keys(got)).toEqual([]);
  });

  it("throws when it cannot establish who you are", async () => {
    stubFetch(() => json({ firstname: "Alex" })); // no id
    await expect(
      new HoldsportClient(baseConfig).myAttendance({ teamId: "1001" }),
    ).rejects.toThrow(/could not read your own user id/);
  });
});

describe("respondToActivity", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const OPEN = {
    id: 900,
    action_path: "/v1/activities/900/activities_users",
    action_method: "POST",
    actions: [
      { activities_user: { user_id: 42, picked: 1, joined_status: 1, name: "Tilmeld" } },
      { activities_user: { user_id: 42, picked: 1, joined_status: 2, name: "Afmeld" } },
    ],
  };

  /** Record every request so the write can be asserted exactly. */
  function stubActivity(activity: unknown): {
    calls: () => Array<{ method: string; path: string; body: unknown }>;
  } {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    stubFetch((url, init) => {
      const u = new URL(url);
      calls.push({
        method: init.method ?? "GET",
        path: u.pathname,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if ((init.method ?? "GET") === "GET") return json(activity);
      return json({ ok: true });
    });
    return { calls: () => calls };
  }

  it("refuses to write without an explicit confirm", async () => {
    stubActivity(OPEN);
    await expect(
      new HoldsportClient(baseConfig).respondToActivity(900, "attend"),
    ).rejects.toThrow(/refusing to write/);
  });

  it("sends the server's own body, path and method verbatim", async () => {
    const { calls } = stubActivity(OPEN);
    const r = await new HoldsportClient(baseConfig).respondToActivity(
      900,
      "attend",
      { confirm: true },
    );
    expect(r).toEqual({ name: "Tilmeld", joined_status: 1 });

    const write = calls().find((c) => c.method !== "GET")!;
    expect(write.method).toBe("POST");
    expect(write.path).toBe("/v1/activities/900/activities_users");
    // The label the UI shows is not part of the payload.
    expect(write.body).toEqual({
      activities_user: { user_id: 42, picked: 1, joined_status: 1 },
    });
  });

  it("uses PUT and a row-specific path when the server says so", async () => {
    // Changing an existing answer targets the row, not the collection.
    const { calls } = stubActivity({
      ...OPEN,
      action_method: "PUT",
      action_path: "/v1/activities/900/activities_users/555",
    });
    await new HoldsportClient(baseConfig).respondToActivity(900, "decline", {
      confirm: true,
    });
    const write = calls().find((c) => c.method !== "GET")!;
    expect(write.method).toBe("PUT");
    expect(write.path).toBe("/v1/activities/900/activities_users/555");
    expect(write.body).toEqual({
      activities_user: { user_id: 42, picked: 1, joined_status: 2 },
    });
  });

  it("refuses when registration has closed", async () => {
    // A real closed activity answers with an empty actions array.
    stubActivity({ ...OPEN, actions: [] });
    await expect(
      new HoldsportClient(baseConfig).respondToActivity(900, "decline", {
        confirm: true,
      }),
    ).rejects.toThrow(/accepts no response right now/);
  });

  it("refuses when the wanted answer is not on offer", async () => {
    stubActivity({
      ...OPEN,
      actions: [
        { activities_user: { user_id: 42, picked: 1, joined_status: 2, name: "Afmeld" } },
      ],
    });
    await expect(
      new HoldsportClient(baseConfig).respondToActivity(900, "attend", {
        confirm: true,
      }),
    ).rejects.toThrow(/offers no "attend" option/);
  });

  it("re-reads the activity immediately before writing", async () => {
    // A plan drawn up an hour ago may offer a choice the server no longer
    // takes; the fresh read is what turns that into a loud failure.
    const { calls } = stubActivity(OPEN);
    await new HoldsportClient(baseConfig).respondToActivity(900, "attend", {
      confirm: true,
    });
    expect(calls()[0]!.method).toBe("GET");
    expect(calls()[0]!.path).toBe("/v1/activities/900");
  });

  it("surfaces a server rejection rather than reporting success", async () => {
    stubFetch((url, init) =>
      (init.method ?? "GET") === "GET"
        ? json(OPEN)
        : json({ error: "too late" }, 422, "Unprocessable Entity"),
    );
    await expect(
      new HoldsportClient(baseConfig).respondToActivity(900, "attend", {
        confirm: true,
      }),
    ).rejects.toThrow(/HTTP 422/);
  });
});

describe("activity capacity", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  const row = (over: Record<string, unknown>) => ({
    id: 1,
    name: "Prøve at være målmand",
    starttime: { iso8601: "2026-09-13T10:00:00+02:00" },
    endtime: { iso8601: "2026-09-13T11:00:00+02:00" },
    event_type: { name: "Medlemsaktivitet" },
    attendee_count: 3,
    ...over,
  });

  it("reports a real cap and its waiting list", async () => {
    stubGraphql({ activityGroups: [{ activities: [row({ max_attender: 2, has_waiting_list: true })] }] });
    const [a] = await new HoldsportClient(chatConfig).listActivities({ teamId: "1001" });
    expect(a!.max_attendees).toBe(2);
    expect(a!.has_waiting_list).toBe(true);
    // Over its cap: further sign-ups land on the waiting list.
    expect(a!.attendee_count).toBe(3);
  });

  it("treats Holdsport's 999 sentinel as uncapped", async () => {
    // Every ordinary session carries 999; surfacing "50 of 999" would be noise.
    stubGraphql({ activityGroups: [{ activities: [row({ max_attender: 999 })] }] });
    const [a] = await new HoldsportClient(chatConfig).listActivities({ teamId: "1001" });
    expect(a!.max_attendees).toBeNull();
  });

  it("treats a missing or zero cap as uncapped", async () => {
    stubGraphql({ activityGroups: [{ activities: [row({ max_attender: 0 }), row({ id: 2 })] }] });
    const rows = await new HoldsportClient(chatConfig).listActivities({ teamId: "1001" });
    expect(rows.map((r) => r.max_attendees)).toEqual([null, null]);
    expect(rows.map((r) => r.has_waiting_list)).toEqual([false, false]);
  });
});

describe("myAttendance reports whether a change is still possible", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("marks an activity with no offered actions as closed", async () => {
    // A closed registration answers with an empty actions array. Surfacing it
    // here means a caller never offers a choice the server will refuse.
    stubFetch((url) => {
      if (String(url).endsWith("/user")) return json({ id: 7 });
      // Page 2 is empty, which is how the server signals the end — serving a
      // full page forever would now be read as truncation, correctly.
      if (Number(new URL(String(url)).searchParams.get("page")) > 1) return json([]);
      return json([
        { id: 1, starttime: "2026-06-04T16:00:00+02:00", actions: [], activities_users: [] },
        {
          id: 2,
          starttime: "2026-06-05T16:00:00+02:00",
          actions: [{ activities_user: { joined_status: 2, name: "Afmeld" } }],
          activities_users: [],
        },
        {
          id: 3,
          starttime: "2026-06-06T16:00:00+02:00",
          // A non-empty array carrying no answer accepts nothing.
          actions: [{}, {}],
          activities_users: [],
        },
      ]);
    });
    const got = await new HoldsportClient(baseConfig).myAttendance({
      teamId: "1001",
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(got[1]!.can_respond).toBe(false);
    expect(got[2]!.can_respond).toBe(true);
    // Entries with no activities_user carry no answer, so this accepts nothing
    // — counting the array's length would have called it open.
    expect(got[3]!.can_respond).toBe(false);
  });
});

describe("registration deadline", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearChatTokenCache();
  });

  it("reports when sign-up closed", async () => {
    // This is what "Tilmeldingsfristen er overskredet" means in the app. REST
    // never exposes it — it reports only an empty actions array — so without
    // this a closed activity can be detected but not explained.
    stubGraphql({
      activityGroups: [
        {
          activities: [
            {
              id: 1,
              name: "Efterårsstævne",
              starttime: { iso8601: "2026-09-19T08:00:00+02:00" },
              endtime: { iso8601: "2026-09-19T17:00:00+02:00" },
              absolute_registration_deadline: { iso8601: "2026-08-29T10:00:00Z" },
            },
          ],
        },
      ],
    });
    const [a] = await new HoldsportClient(chatConfig).listActivities({ teamId: "1001" });
    expect(a!.registration_deadline).toBe("2026-08-29T10:00:00Z");
  });

  it("leaves it empty when no deadline is set", async () => {
    stubGraphql({
      activityGroups: [
        {
          activities: [
            { id: 2, name: "Træning", starttime: { iso8601: "2026-09-16T18:10:00+02:00" } },
          ],
        },
      ],
    });
    const [a] = await new HoldsportClient(chatConfig).listActivities({ teamId: "1001" });
    expect(a!.registration_deadline).toBe("");
  });
});

describe("date helpers", () => {
  it("shifts a date across a DST transition without rounding", () => {
    // Denmark loses an hour on 29 Mar and gains one on 25 Oct; anchoring at
    // midday UTC keeps a whole-day shift on the day it belongs to.
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
  });

  it("goes backwards and across month and year ends", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("refuses a date it cannot parse", () => {
    expect(() => addDays("2026-6-30", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => addDays("not a date", 1)).toThrow(/YYYY-MM-DD/);
  });

  it("reports today in the team's timezone, not the machine's", () => {
    // The distinction that matters: teamToday follows Danish days even when
    // the machine is elsewhere, which is why it exists alongside localToday.
    expect(teamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const danish = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Copenhagen",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    expect(teamToday()).toBe(danish);
  });
});

describe("myAttendance guards its window like its sibling", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A page budget's worth of activities that never runs out. */
  function stubEndless(): void {
    stubFetch((url) => {
      if (String(url).endsWith("/user")) return json({ id: 7 });
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return json([
        {
          id: page,
          starttime: `2026-06-${String((page % 28) + 1).padStart(2, "0")}T16:00:00+02:00`,
          actions: [],
          activities_users: [],
        },
      ]);
    });
  }

  it("refuses rather than returning a map truncated at maxPages", async () => {
    // The sibling throws for this reason; returning a partial map would have
    // the caller report "no sign-up recorded" for activities never fetched.
    stubEndless();
    await expect(
      new HoldsportClient(baseConfig).myAttendance({
        teamId: "1001",
        from: "2026-06-01",
        to: "2026-12-31",
        maxPages: 3,
      }),
    ).rejects.toThrow(/stopped at the 3-page limit/);
  });

  it("rejects a date that is not zero-padded", async () => {
    stubEndless();
    await expect(
      new HoldsportClient(baseConfig).myAttendance({
        teamId: "1001",
        from: "2026-06-01",
        to: "2026-6-30",
      }),
    ).rejects.toThrow(/to must be YYYY-MM-DD/);
  });

  it("rejects a maxPages that would fetch nothing", async () => {
    stubEndless();
    // Returning {} here is indistinguishable from "this team has no activities".
    await expect(
      new HoldsportClient(baseConfig).myAttendance({ teamId: "1001", maxPages: 0 }),
    ).rejects.toThrow(/maxPages must be a positive whole number/);
  });

  it("separates having no row from having a row with no status", async () => {
    stubFetch((url) => {
      if (String(url).endsWith("/user")) return json({ id: 7 });
      if (Number(new URL(String(url)).searchParams.get("page")) > 1) return json([]);
      return json([
        { id: 1, starttime: "2026-06-04T16:00:00+02:00", actions: [], activities_users: [] },
        {
          id: 2,
          starttime: "2026-06-05T16:00:00+02:00",
          actions: [],
          activities_users: [{ user_id: 7, status: "Ukendt", updated_at: "2026-06-01T09:00:00+02:00" }],
        },
      ]);
    });
    const got = await new HoldsportClient(baseConfig).myAttendance({ teamId: "1001" });
    expect(got[1]!.code).toBe(-1);
    // A row exists, so -1 would be wrong — a caller reading it as "not asked
    // yet" would offer to sign up someone who already has an answer recorded.
    expect(got[2]!.code).toBe(0);
    expect(got[2]!.label).toBe("Ukendt");
  });
});

describe("respondToActivity refuses to invent a request", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const OPEN_ACTIONS = [
    { activities_user: { user_id: 42, picked: 1, joined_status: 1, name: "Tilmeld" } },
    { activities_user: { user_id: 42, picked: 1, joined_status: 2, name: "Afmeld" } },
  ];

  /** Serve one activity and record any write that escapes. */
  function stubActivity(activity: unknown): { writes: () => string[] } {
    const writes: string[] = [];
    stubFetch((url, init) => {
      if ((init.method ?? "GET") !== "GET") {
        writes.push(`${init.method} ${url}`);
        return json({ ok: true });
      }
      return json(activity);
    });
    return { writes: () => writes };
  }

  it("refuses when the server offers responses but no path", async () => {
    // Defaulting to "" would POST the payload at the API root.
    const { writes } = stubActivity({
      id: 900,
      action_method: "POST",
      actions: OPEN_ACTIONS,
    });
    await expect(
      new HoldsportClient(baseConfig).respondToActivity(900, "attend", { confirm: true }),
    ).rejects.toThrow(/no action_path/);
    expect(writes()).toEqual([]);
  });

  it("refuses when the method is missing, rather than assuming POST", async () => {
    // The dangerous shape: a row-specific path with no method. Assuming POST
    // would create a second row instead of updating the existing answer.
    const { writes } = stubActivity({
      id: 900,
      action_path: "/v1/activities/900/activities_users/555",
      actions: OPEN_ACTIONS,
    });
    await expect(
      new HoldsportClient(baseConfig).respondToActivity(900, "decline", { confirm: true }),
    ).rejects.toThrow(/no action_method/);
    expect(writes()).toEqual([]);
  });

  it("will not send credentials to a host the server chose", async () => {
    // action_path is response data, and the request carries HTTP Basic auth.
    const { writes } = stubActivity({
      id: 900,
      action_method: "POST",
      action_path: "https://evil.example.com/v1/activities/900/activities_users",
      actions: OPEN_ACTIONS,
    });
    await expect(
      new HoldsportClient(baseConfig).respondToActivity(900, "attend", { confirm: true }),
    ).rejects.toThrow(/refusing to send credentials to evil.example.com/);
    expect(writes()).toEqual([]);
  });

  it("drops an action whose joined_status is not a real answer", async () => {
    // Number(undefined) is NaN, which would slip past the closed-registration
    // refusal and then match nothing, reporting "available: Tilmeld (NaN)".
    stubActivity({
      id: 900,
      action_method: "POST",
      action_path: "/v1/activities/900/activities_users",
      actions: [
        { activities_user: { user_id: 42, name: "Tilmeld" } },
        { activities_user: { user_id: 42, joined_status: "nonsense", name: "Afmeld" } },
      ],
    });
    const client = new HoldsportClient(baseConfig);
    expect(await client.attendanceActions(900)).toEqual([]);
    await expect(
      client.respondToActivity(900, "attend", { confirm: true }),
    ).rejects.toThrow(/accepts no response right now/);
  });
});
