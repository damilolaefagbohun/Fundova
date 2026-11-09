// Who may do what through db.js. Every request is checked here before it reaches the database.
// authorize({user, method, path, body}) -> {ok:true, path, body} or {ok:false, status, reason}
// "user" is null for visitors who are not signed in (only the few public actions below are allowed).

const TABLES = new Set([
  'bank_details','cooperative_bonuses','coordinator_applications','coordinator_earnings','deals',
  'food_scheme_enrollments','food_scheme_history','food_scheme_options','food_scheme_settings','goals',
  'group_contributions','group_invitations','group_members','group_payouts','investment_income',
  'investment_refund_requests','investment_reservations','investments','kyc_audit_log','kyc_details',
  'notifications','payments','profile_update_requests','savings_groups','signup_requests','system_errors',
  'users','webinar_registrations','webinars','withdrawal_requests'
]);
// never reachable through db.js, for anyone
const DENIED = new Set(['password_resets', 'login_codes']);

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const SPECIAL = new Set(['select', 'order', 'limit', 'offset']);
const OPS = /^(eq|neq|gt|gte|lt|lte|is|in|like|ilike|not\.eq|not\.is|not\.in)\./;
const COL = /^[a-z_][a-z0-9_]{0,60}$/;
const SELECT_RE = /^[a-z0-9_,*]{1,400}$/;
const ORDER_RE = /^[a-z0-9_.,]{1,200}$/;

function deny(reason, status) { return { ok: false, status: status || 403, reason }; }

// Break "table?a=b&c=d" into pieces. Anything unusual is refused.
function parsePath(path) {
  if (typeof path !== 'string' || path.length > 4000) return null;
  const q = path.indexOf('?');
  const table = q === -1 ? path : path.slice(0, q);
  const qs = q === -1 ? '' : path.slice(q + 1);
  if (!/^[a-z_]+$/.test(table)) return null;
  const params = []; // ordered [key, value]
  if (qs) {
    for (const part of qs.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      if (i < 1) return null;
      let k, v;
      try { k = decodeURIComponent(part.slice(0, i)); v = decodeURIComponent(part.slice(i + 1)); } catch (e) { return null; }
      params.push([k, v]);
    }
  }
  return { table, params };
}

function validateParams(params) {
  for (const [k, v] of params) {
    if (SPECIAL.has(k)) {
      if (k === 'select' && (!SELECT_RE.test(v) || /(^|,)pin(,|$)/.test(v))) {
        // select=pin on users is refused outright; select=* is fine because pin is stripped from every answer
        return 'bad select';
      }
      if (k === 'order' && (!ORDER_RE.test(v) || /(^|,)pin(\.|,|$)/.test(v))) return 'bad order';
      if ((k === 'limit' || k === 'offset') && !/^\d{1,6}$/.test(v)) return 'bad ' + k;
      if (k === 'limit' && Number(v) > 5000) return 'limit too high';
      continue;
    }
    if (!COL.test(k)) return 'bad filter column';
    if (k === 'pin') return 'pin cannot be filtered';
    if (!OPS.test(v)) return 'bad filter operator';
    if (v.length > 3000) return 'filter too long';
  }
  return null;
}

const get = (params, key) => { const r = params.find(p => p[0] === key); return r ? r[1] : undefined; };
const eqVal = (params, key) => { const v = get(params, key); return v && v.startsWith('eq.') ? v.slice(3) : undefined; };
const inVals = (params, key) => {
  const v = get(params, key);
  if (!v || !v.startsWith('in.(') || !v.endsWith(')')) return undefined;
  return v.slice(4, -1).split(',').map(s => s.replace(/^"|"$/g, '').trim()).filter(Boolean);
};
const selectCols = (params) => { const s = get(params, 'select'); return s ? s.split(',') : ['*']; };
const subset = (cols, allowed) => cols.every(c => allowed.includes(c));
const hasFilter = (params) => params.some(p => !SPECIAL.has(p[0]));
const isObj = (b) => b && typeof b === 'object' && !Array.isArray(b);
const rows = (b) => Array.isArray(b) ? b : (isObj(b) ? [b] : []);
const onlyKeys = (b, allowed) => rows(b).every(r => Object.keys(r).every(k => allowed.includes(k)));

// Plain helpers used by tables that belong to one member
const ownScope = (ctx) => eqVal(ctx.params, 'user_id') === ctx.uid;
function forceOwner(ctx, field) {
  const f = field || 'user_id';
  const rs = rows(ctx.body);
  if (!rs.length) return false;
  for (const r of rs) r[f] = ctx.uid;
  return true;
}

// ── public (not signed in) actions ──
function publicRule(parsed, method, body) {
  const { table, params } = parsed;
  if (method === 'GET' && table === 'users') {
    if (get(params, 'role') === 'eq.contributor' && get(params, 'select') === 'id' && params.length === 2) return { ok: true, countOnly: true };
  }
  if (method === 'GET' && table === 'webinars' && get(params, 'status') === 'eq.active' && get(params, 'select') === '*' && get(params, 'limit') === '1' && params.length === 3) return { ok: true };
  if (method === 'GET' && table === 'deals' && get(params, 'status') === 'eq.featured' && params.every(p => ['status', 'select', 'order'].includes(p[0]))) return { ok: true };
  if (method === 'POST' && table === 'signup_requests' && isObj(body)) {
    const allowed = ['name', 'email', 'phone', 'whatsapp', 'referred_by', 'status'];
    if (!Object.keys(body).every(k => allowed.includes(k))) return deny('signup fields');
    body.status = 'pending';
    return { ok: true, body };
  }
  if (method === 'POST' && table === 'webinar_registrations' && isObj(body)) {
    const allowed = ['name', 'email', 'phone', 'webinar_id'];
    if (!Object.keys(body).every(k => allowed.includes(k))) return deny('registration fields');
    return { ok: true, body };
  }
  if (method === 'POST' && table === 'system_errors' && isObj(body)) return { ok: true };
  return null;
}

// ── per-table rules for signed-in members (contributors, coordinators, pending) ──
// ctx: {uid, method, params, body, ownerOf(table,id)->Promise<user_id|null>}
const MEMBER = {
  users: async (c) => {
    if (c.method !== 'GET') return 'members cannot change user records';
    const cols = selectCols(c.params);
    if (eqVal(c.params, 'id') === c.uid) return true;
    const ids = inVals(c.params, 'id') || (eqVal(c.params, 'id') ? [eqVal(c.params, 'id')] : null);
    if (ids && subset(cols, ['id', 'name', 'email', 'phone', 'whatsapp'])) return true;
    if (eqVal(c.params, 'email') && subset(cols, ['id'])) return true; // "is this person already a member" checks
    if (subset(cols, ['id']) && get(c.params, 'role') === 'eq.contributor') return true; // member counts
    if (subset(cols, ['id', 'name']) && get(c.params, 'role') === 'eq.contributor') return true;
    return 'users read';
  },
  bank_details: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own bank only';
    if (c.method === 'POST') return forceOwner(c) || 'bad body';
    if (c.method === 'PATCH') {
      if (eqVal(c.params, 'user_id') === c.uid) return true;
      const id = eqVal(c.params, 'id');
      return (id && (await c.ownerOf('bank_details', id)) === c.uid) || 'own bank only';
    }
    return 'not allowed';
  },
  kyc_details: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own kyc only';
    if (c.method === 'POST' || c.method === 'PATCH') {
      if (c.method === 'POST') forceOwner(c);
      else if (eqVal(c.params, 'user_id') !== c.uid) return 'own kyc only';
      for (const r of rows(c.body)) { r.kyc_verified = false; delete r.verified_at; delete r.verified_by; }
      return true;
    }
    return 'not allowed';
  },
  kyc_audit_log: async (c) => (c.method === 'POST' && forceOwner(c)) || 'not allowed',
  withdrawal_requests: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own requests only';
    if (c.method === 'POST') { if (!forceOwner(c)) return 'bad body'; for (const r of rows(c.body)) r.status = 'pending'; return true; }
    return 'not allowed';
  },
  notifications: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'PATCH') return (ownScope(c) && onlyKeys(c.body, ['read'])) || 'own only';
    if (c.method === 'POST') return rows(c.body).every(r => JSON.stringify(r).length < 4000) || 'too large';
    return 'not allowed';
  },
  goals: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'POST') return forceOwner(c) || 'bad body';
    if (c.method === 'PATCH') { const id = eqVal(c.params, 'id'); return (id && (await c.ownerOf('goals', id)) === c.uid) || 'own only'; }
    return 'not allowed';
  },
  food_scheme_enrollments: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'POST') {
      if (!forceOwner(c)) return 'bad body';
      for (const r of rows(c.body)) r.status = 'opted_in';
      return onlyKeys(c.body, ['user_id', 'option_id', 'status']) || 'fields';
    }
    if (c.method === 'PATCH') {
      if (!ownScope(c)) return 'own only';
      if (!onlyKeys(c.body, ['option_id', 'status', 'enrolled_at'])) return 'fields';
      return rows(c.body).every(r => r.status === undefined || r.status === 'opted_in') || 'status';
    }
    if (c.method === 'DELETE') return ownScope(c) || 'own only';
    return 'not allowed';
  },
  food_scheme_history: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'POST') {
      if (!forceOwner(c)) return 'bad body';
      return rows(c.body).every(r => ['opted_in', 'package_changed', 'opted_out'].includes(r.event)) || 'event';
    }
    return 'not allowed';
  },
  food_scheme_options: async (c) => c.method === 'GET' || 'read only',
  food_scheme_settings: async (c) => c.method === 'GET' || 'read only',
  payments: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own payments only';
    if (c.method === 'POST') {
      if (!forceOwner(c)) return 'bad body';
      if (!onlyKeys(c.body, ['user_id', 'amount', 'date', 'withdrawn', 'goal_id', 'is_transfer', 'is_interest', 'purpose'])) return 'fields';
      for (const r of rows(c.body)) r.withdrawn = false;
      return true;
    }
    if (c.method === 'PATCH') {
      const id = eqVal(c.params, 'id');
      if (!id || (await c.ownerOf('payments', id)) !== c.uid) return 'own payments only';
      return onlyKeys(c.body, ['withdrawn', 'withdrawn_at', 'moved_at', 'goal_id']) || 'fields';
    }
    return 'not allowed';
  },
  investments: async (c) => c.method === 'GET' || 'read only',
  investment_income: async (c) => c.method === 'GET' || 'read only',
  investment_reservations: async (c) => {
    if (c.method === 'GET') {
      if (ownScope(c)) return true;
      return (subset(selectCols(c.params), ['investment_id', 'units']) && !!(get(c.params, 'investment_id'))) || 'own reservations only';
    }
    if (c.method === 'POST') { if (!forceOwner(c)) return 'bad body'; for (const r of rows(c.body)) r.status = 'pending'; return true; }
    if (c.method === 'PATCH') {
      const id = eqVal(c.params, 'id');
      if (!id || (await c.ownerOf('investment_reservations', id)) !== c.uid) return 'own only';
      return (onlyKeys(c.body, ['status', 'payment_made_at']) && rows(c.body).every(r => r.status === undefined || r.status === 'payment_made')) || 'fields';
    }
    return 'not allowed';
  },
  investment_refund_requests: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'POST') { if (!forceOwner(c)) return 'bad body'; for (const r of rows(c.body)) r.status = 'pending'; return true; }
    return 'not allowed';
  },
  deals: async (c) => {
    if (c.method === 'GET') return true;
    if (c.method === 'POST') { if (!forceOwner(c)) return 'bad body'; for (const r of rows(c.body)) r.status = 'pending'; return true; }
    if (c.method === 'PATCH') {
      // featured deals that have run out are moved back to "approved" by whoever loads the page
      return (onlyKeys(c.body, ['status']) && rows(c.body).every(r => r.status === 'approved')) || 'deals admin only';
    }
    return 'not allowed';
  },
  cooperative_bonuses: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'POST') return forceOwner(c) || 'bad body';
    if (c.method === 'PATCH') { const id = eqVal(c.params, 'id'); return (id && (await c.ownerOf('cooperative_bonuses', id)) === c.uid) || 'own only'; }
    return 'not allowed';
  },
  profile_update_requests: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'POST') { if (!forceOwner(c)) return 'bad body'; for (const r of rows(c.body)) r.status = 'pending'; return true; }
    return 'not allowed';
  },
  coordinator_applications: async (c) => {
    if (c.method === 'GET') return ownScope(c) || 'own only';
    if (c.method === 'POST') { if (!forceOwner(c)) return 'bad body'; for (const r of rows(c.body)) r.status = 'pending'; return true; }
    return 'not allowed';
  },
  webinars: async (c) => c.method === 'GET' || 'read only',
  webinar_registrations: async (c) => (c.method === 'POST' && onlyKeys(c.body, ['name', 'email', 'phone', 'webinar_id'])) || 'not allowed',
  system_errors: async (c) => c.method === 'POST' || 'not allowed',
  // group savings: coordinators and members work with these; per-row ownership checks come in the next stage
  savings_groups: async (c) => c.method !== 'DELETE' || 'not allowed',
  group_members: async (c) => c.method !== 'DELETE' || 'not allowed',
  group_contributions: async (c) => (c.method === 'GET' || c.method === 'POST' || c.method === 'PATCH') || 'not allowed',
  group_payouts: async (c) => (c.method === 'GET' || c.method === 'POST' || c.method === 'PATCH') || 'not allowed',
  group_invitations: async (c) => c.method === 'POST' || 'not allowed',
  coordinator_earnings: async (c) => (c.method === 'GET' || c.method === 'POST') || 'not allowed'
};

// read-only admin: may read everything, and write only an audit/error note
const VIEW_WRITE = new Set(['kyc_audit_log', 'system_errors']);

async function authorize({ user, method, path, body, ownerOf }) {
  method = String(method || 'GET').toUpperCase();
  if (!METHODS.has(method)) return deny('method');
  const parsed = parsePath(path);
  if (!parsed) return deny('bad path', 400);
  const { table, params } = parsed;
  if (DENIED.has(table)) return deny('table not available');
  if (!TABLES.has(table)) return deny('unknown table');
  const bad = validateParams(params);
  if (bad) return deny(bad, 400);
  if (method !== 'GET' && method !== 'DELETE' && !(isObj(body) || (Array.isArray(body) && body.length && body.length <= 500))) return deny('bad body', 400);
  if ((method === 'PATCH' || method === 'DELETE') && !hasFilter(params)) return deny('write needs a filter', 400);
  if (Array.isArray(body) && body.some(r => !isObj(r))) return deny('bad body', 400);
  const clone = body == null ? body : JSON.parse(JSON.stringify(body));

  if (!user) {
    const r = publicRule(parsed, method, clone);
    if (!r || r.ok === false) return r || deny('sign in required', 401);
    return { ok: true, path, body: r.body !== undefined ? r.body : clone, countOnly: !!r.countOnly };
  }

  if (user.role === 'admin') return { ok: true, path, body: clone };
  if (user.role === 'admin_view') {
    if (method === 'GET') return { ok: true, path, body: clone };
    return VIEW_WRITE.has(table) && method === 'POST' ? { ok: true, path, body: clone } : deny('read-only account');
  }

  const rule = MEMBER[table];
  if (!rule) return deny('admin only');
  const ctx = { uid: String(user.uid), method, params, body: clone, ownerOf: ownerOf || (async () => null) };
  const verdict = await rule(ctx);
  if (verdict !== true) return deny(typeof verdict === 'string' ? verdict : 'not allowed');
  return { ok: true, path, body: ctx.body };
}

module.exports = { authorize, parsePath, TABLES, DENIED };
