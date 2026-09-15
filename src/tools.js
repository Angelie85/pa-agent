import { calendar, gmail } from './google.js';
import {
  addTask,
  listTasks,
  completeTask,
  deleteTask,
  addReminder,
  listReminders,
  deleteReminder,
} from './store.js';

const TIMEZONE = process.env.TIMEZONE || 'America/New_York';

// --- Tool schemas (sent to Claude) ---
export const tools = [
  {
    name: 'list_events',
    description:
      'List calendar events in a time range. Use for "what\'s on my calendar", "am I free at X". Resolve vague times to concrete ISO 8601 datetimes first.',
    input_schema: {
      type: 'object',
      properties: {
        time_min: {
          type: 'string',
          description: 'ISO 8601 datetime, start of range (inclusive). e.g. 2026-09-13T00:00:00-04:00',
        },
        time_max: {
          type: 'string',
          description: 'ISO 8601 datetime, end of range (exclusive).',
        },
      },
      required: ['time_min', 'time_max'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a calendar event on the primary calendar.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'ISO 8601 datetime for start' },
        end: { type: 'string', description: 'ISO 8601 datetime for end' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete a calendar event by ID. Confirm with the user before calling.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'add_task',
    description: 'Add a task to the to-do list.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List open tasks. Set include_done=true to include completed ones.',
    input_schema: {
      type: 'object',
      properties: {
        include_done: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done by its numeric ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Delete a task by its numeric ID. Confirm before calling.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    },
  },

  // --- Reminders ---
  {
    name: 'schedule_reminder',
    description:
      'Schedule a Telegram reminder to be sent to the user at a specific time. Resolve vague times ("in 20 min", "tomorrow 9am") to a concrete ISO 8601 datetime with timezone offset first. The message should be short and phrased as a nudge (e.g. "Call Sam" not "Reminder: to call Sam").',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The reminder text to send' },
        fire_at: {
          type: 'string',
          description:
            'ISO 8601 datetime with timezone offset when the reminder should fire. e.g. 2026-09-14T15:00:00-04:00',
        },
      },
      required: ['message', 'fire_at'],
    },
  },
  {
    name: 'list_reminders',
    description:
      'List the current user\'s pending reminders (not yet fired). Set include_fired=true to include past ones.',
    input_schema: {
      type: 'object',
      properties: {
        include_fired: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'delete_reminder',
    description: 'Cancel a pending reminder by its numeric ID. Confirm before calling.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
      },
      required: ['id'],
    },
  },

  // --- Gmail tools ---
  {
    name: 'search_gmail',
    description:
      'Search Gmail using Gmail query syntax. Examples: "from:sam@example.com", "subject:invoice", "after:2026/1/1 has:attachment", "from:oleana". Returns matching messages with headers and snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query' },
        max_results: { type: 'integer', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_email',
    description:
      'Fetch the full body of a single email by message_id (obtained from search_gmail or list_recent_emails). Use to read a specific message before drafting a reply.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'list_recent_emails',
    description: 'List recent inbox emails. Useful for "what\'s new in my inbox".',
    input_schema: {
      type: 'object',
      properties: {
        max_results: { type: 'integer', default: 10 },
      },
    },
  },
  {
    name: 'create_email_draft',
    description:
      'Create a Gmail draft. DOES NOT SEND. Always call this first, then show the draft to the user and wait for explicit confirmation (e.g. "send") before calling send_email_draft. For replies, pass thread_id and in_reply_to (from read_email or search_gmail results).',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain text body of the email' },
        thread_id: {
          type: 'string',
          description: 'Optional: existing Gmail thread ID (for replies)',
        },
        in_reply_to: {
          type: 'string',
          description: 'Optional: Message-ID header of the email being replied to',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'send_email_draft',
    description:
      'Send a Gmail draft by draft_id. ONLY call after the user has explicitly confirmed they want to send. Never send without explicit confirmation of recipient, subject, and body.',
    input_schema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string' },
      },
      required: ['draft_id'],
    },
  },
];

// --- Handlers ---
const handlers = {
  async list_events({ time_min, time_max }) {
    const cal = calendar();
    const { data } = await cal.events.list({
      calendarId: 'primary',
      timeMin: time_min,
      timeMax: time_max,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    return (data.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      location: e.location,
    }));
  },

  async create_event({ summary, start, end, description, location }) {
    const cal = calendar();
    const { data } = await cal.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        location,
        start: { dateTime: start, timeZone: TIMEZONE },
        end: { dateTime: end, timeZone: TIMEZONE },
      },
    });
    return {
      id: data.id,
      summary: data.summary,
      start: data.start?.dateTime,
      end: data.end?.dateTime,
      htmlLink: data.htmlLink,
    };
  },

  async delete_event({ event_id }) {
    const cal = calendar();
    await cal.events.delete({ calendarId: 'primary', eventId: event_id });
    return { deleted: true, event_id };
  },

  async add_task({ title }) {
    return addTask(title);
  },

  async list_tasks({ include_done = false } = {}) {
    return listTasks({ includeDone: include_done });
  },

  async complete_task({ id }) {
    const row = completeTask(id);
    return row ?? { error: `No task with id ${id}` };
  },

  async delete_task({ id }) {
    const row = deleteTask(id);
    return row ?? { error: `No task with id ${id}` };
  },

  // --- Reminder handlers ---
  async schedule_reminder({ message, fire_at }, { userId } = {}) {
    if (!userId) return { error: 'No user context — cannot schedule reminder' };
    const when = new Date(fire_at);
    if (Number.isNaN(when.getTime())) {
      return { error: `Invalid fire_at: ${fire_at}` };
    }
    if (when.getTime() <= Date.now()) {
      return { error: 'fire_at must be in the future' };
    }
    const row = addReminder({
      userId,
      message,
      fireAt: when.toISOString(),
    });
    return {
      id: row.id,
      message: row.message,
      fire_at: row.fire_at,
    };
  },

  async list_reminders({ include_fired = false } = {}, { userId } = {}) {
    if (!userId) return { error: 'No user context' };
    return listReminders({ userId, includeFired: include_fired });
  },

  async delete_reminder({ id }) {
    const row = deleteReminder(id);
    return row ?? { error: `No reminder with id ${id}` };
  },

  // --- Gmail handlers ---
  async search_gmail({ query, max_results = 10 }) {
    const g = gmail();
    const { data } = await g.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: max_results,
    });
    const messages = data.messages ?? [];
    return Promise.all(
      messages.map(async (m) => {
        const { data: msg } = await g.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'],
        });
        const headers = Object.fromEntries(
          (msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
        );
        return {
          message_id: msg.id,
          thread_id: msg.threadId,
          from: headers.from,
          to: headers.to,
          subject: headers.subject,
          date: headers.date,
          message_id_header: headers['message-id'],
          snippet: msg.snippet,
        };
      })
    );
  },

  async read_email({ message_id }) {
    const g = gmail();
    const { data } = await g.users.messages.get({
      userId: 'me',
      id: message_id,
      format: 'full',
    });
    const headers = Object.fromEntries(
      (data.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
    );
    const body = extractBody(data.payload).slice(0, 5000);
    return {
      message_id: data.id,
      thread_id: data.threadId,
      from: headers.from,
      to: headers.to,
      subject: headers.subject,
      date: headers.date,
      message_id_header: headers['message-id'],
      body,
    };
  },

  async list_recent_emails({ max_results = 10 } = {}) {
    return handlers.search_gmail({ query: 'in:inbox', max_results });
  },

  async create_email_draft({ to, subject, body, thread_id, in_reply_to }) {
    const g = gmail();
    const lines = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
    ];
    if (in_reply_to) {
      lines.push(`In-Reply-To: ${in_reply_to}`);
      lines.push(`References: ${in_reply_to}`);
    }
    const rawMessage = [...lines, '', body].join('\r\n');
    const encoded = Buffer.from(rawMessage).toString('base64url');

    const { data } = await g.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encoded,
          ...(thread_id ? { threadId: thread_id } : {}),
        },
      },
    });
    return {
      draft_id: data.id,
      to,
      subject,
      body_preview: body.slice(0, 500),
    };
  },

  async send_email_draft({ draft_id }) {
    const g = gmail();
    const { data } = await g.users.drafts.send({
      userId: 'me',
      requestBody: { id: draft_id },
    });
    return { sent: true, message_id: data.id, thread_id: data.threadId };
  },
};

// Walk a Gmail payload tree to find the plain-text body (falls back to stripped HTML)
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf8');
    return html.replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (payload.parts) {
    // Prefer plain text if available
    const plain = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plain) {
      const t = extractBody(plain);
      if (t) return t;
    }
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return '';
}

export async function dispatchTool(name, input, context = {}) {
  const fn = handlers[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  try {
    return await fn(input, context);
  } catch (err) {
    console.error(`Tool ${name} failed:`, err);
    return { error: err.message };
  }
}
