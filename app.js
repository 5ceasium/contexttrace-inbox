/* ContextTrace cloud Decision Inbox — client
 *
 * Everything here runs in the viewer's browser and ships with the anon key, so
 * nothing in this file is trusted. Authorization is Postgres RLS; the code
 * below only decides what to *ask* for. If a policy is wrong, this app cannot
 * save us, and if this app is wrong, the policies still hold.
 *
 * Two behaviours worth knowing before reading:
 *
 *  - Resolving goes through the `resolve_decision` RPC with the version the
 *    client last saw. A colleague answering the same card first makes the
 *    write fail loudly rather than silently replacing their answer.
 *  - Blinded cards never request peers' responses. The RLS policy would refuse
 *    anyway, but asking and being denied still tells you a response exists,
 *    which is itself an anchor.
 */

(function () {
  "use strict";

  const CFG = window.CONTEXTTRACE_CONFIG || {};
  const VALUES = ["APPROVED", "REVISE", "REJECTED", "FRAMING_WRONG"];
  const KEYMAP = { a: "APPROVED", r: "REVISE", x: "REJECTED", f: "FRAMING_WRONG" };
  const LABELS = {
    APPROVED: "Approve",
    REVISE: "Revise",
    REJECTED: "Reject",
    FRAMING_WRONG: "Framing wrong",
  };
  const TIME_LABEL = {
    "30_SEC": "30 sec", "2_MIN": "2 min", "5_MIN": "5 min", "15_MIN_PLUS": "15 min+",
  };
  const TIME_MIN = { "30_SEC": 0.5, "2_MIN": 2, "5_MIN": 5, "15_MIN_PLUS": 15 };
  const GROUPS = [
    ["BLOCKING_NOW", "Blocking now"],
    ["BLOCKING_LATER", "Blocking later"],
    ["NON_BLOCKING", "Non-blocking"],
  ];

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let sb = null;
  let me = null;         // profiles row
  let decisions = [];
  let reverifications = [];
  let resolved = [];
  let open = null;       // decision currently in the sheet
  let pending = null;    // chosen value, awaiting rationale
  let openedAt = 0;

  // ---- boot ---------------------------------------------------------------

  function configError(msg) {
    $("gate-msg").textContent = msg;
    $("gate-msg").className = "gate-msg is-error";
    $("gate-msg").hidden = false;
    $("login-form").hidden = true;
  }

  async function boot() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
      return configError(
        "config.js is missing SUPABASE_URL / SUPABASE_ANON_KEY. Copy " +
        "config.example.js to config.js and fill in your project's values."
      );
    }
    if (!window.supabase) {
      return configError("The Supabase client failed to load. Check your network and reload.");
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    sb.auth.onAuthStateChange((_evt, session) => { session ? enter() : showGate(); });
    const { data } = await sb.auth.getSession();
    data.session ? enter() : showGate();
  }

  function showGate(msg, isError) {
    $("app").hidden = true;
    $("gate").hidden = false;
    if (msg) {
      $("gate-msg").textContent = msg;
      $("gate-msg").className = "gate-msg" + (isError ? " is-error" : "");
      $("gate-msg").hidden = false;
    }
  }

  // Being signed in is not being authorized. A session with no profile row is
  // rejected here and, more importantly, by every RLS policy.
  async function enter() {
    const { data: prof, error } = await sb
      .from("profiles").select("*").eq("id", (await sb.auth.getUser()).data.user.id).maybeSingle();

    if (error || !prof) {
      await sb.auth.signOut();
      return showGate(
        "That address signed in, but it is not on the authorized list for this " +
        "project, so there is nothing to show you. Ask the project owner for access.",
        true
      );
    }
    if (!prof.active) {
      await sb.auth.signOut();
      return showGate("That account has been deactivated.", true);
    }

    me = prof;
    $("gate").hidden = true;
    $("app").hidden = false;
    $("whoami").textContent = `${prof.display_name || prof.email} · ${prof.role}`;
    await refresh();
    subscribe();
  }

  // ---- data ---------------------------------------------------------------

  async function refresh() {
    const [d, r, h] = await Promise.all([
      sb.from("open_decisions_view").select("*"),
      sb.from("reverifications").select("*").eq("status", "PENDING")
        .order("requested_at", { ascending: false }),
      sb.from("decisions").select("*").neq("status", "OPEN")
        .order("resolved_at", { ascending: false }).limit(100),
    ]);
    if (d.error) return toast(d.error.message, true);
    decisions = d.data || [];
    reverifications = r.data || [];
    resolved = h.data || [];
    renderInbox();
    renderReverify();
    renderHistory();
  }

  function subscribe() {
    sb.channel("decisions-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "decisions" },
        (p) => {
          const row = p.new || p.old || {};
          // Somebody else resolved what you are looking at: say so rather than
          // letting a stale write fail confusingly later.
          if (open && row.decision_id === open.decision_id && row.status && row.status !== "OPEN") {
            closeSheet();
            toast(`"${trim(row.title, 38)}" was just resolved by someone else`, true);
          }
          refresh();
        })
      .on("postgres_changes", { event: "*", schema: "public", table: "reverifications" }, refresh)
      .subscribe();
  }

  const trim = (s, n) => (s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || "");

  // ---- inbox --------------------------------------------------------------

  function renderInbox() {
    const total = decisions.length;
    const mins = decisions.reduce((a, c) => a + (TIME_MIN[c.estimated_human_time] || 5), 0);
    const blocking = decisions.filter((c) => c.priority === "BLOCKING_NOW").length;
    const mine = decisions.filter((c) => c.assigned_to_me).length;

    const s = $("summary");
    s.textContent = "";
    [
      ["open", total],
      ["blocking now", blocking, blocking > 0],
      ["est. time", mins < 60 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(1)} h`],
      ["awaiting acceptance", reverifications.length],
    ].forEach(([k, v, hot]) => {
      const st = el("div", "stat");
      st.append(el("div", "stat-k", k), el("div", "stat-v" + (hot ? " is-blocking" : ""), String(v)));
      s.append(st);
    });

    // Next 3: blocking first, then cheapest, so the ordering buys the most
    // unblocked work per minute of attention rather than just listing.
    const order = { BLOCKING_NOW: 0, BLOCKING_LATER: 1, NON_BLOCKING: 2 };
    const next = [...decisions].sort((a, b) =>
      (order[a.priority] - order[b.priority]) ||
      ((TIME_MIN[a.estimated_human_time] || 5) - (TIME_MIN[b.estimated_human_time] || 5))
    ).slice(0, 3);

    const nl = $("next-list");
    nl.textContent = "";
    $("next-up").hidden = next.length === 0;
    next.forEach((c) => {
      const li = el("li");
      const b = el("button", null, `${c.title} · ${TIME_LABEL[c.estimated_human_time]}`);
      b.onclick = () => openSheet(c);
      li.append(b);
      nl.append(li);
    });

    const g = $("groups");
    g.textContent = "";
    if (!total) {
      g.append(el("p", "empty", "Nothing open. Every card has been answered."));
      return;
    }
    GROUPS.forEach(([key, label]) => {
      const cards = decisions.filter((c) => c.priority === key);
      if (!cards.length) return;
      const wrap = el("div", "group");
      const head = el("div", "group-head");
      const m = cards.reduce((a, c) => a + (TIME_MIN[c.estimated_human_time] || 5), 0);
      head.append(el("h2", null, label), el("span", "count", `${cards.length} · ~${Math.round(m)} min`));
      wrap.append(head);
      cards.forEach((c) => wrap.append(cardNode(c)));
      g.append(wrap);
    });
  }

  function cardNode(c) {
    const n = el("div", `card p-${c.priority}`);
    n.tabIndex = 0;
    const top = el("div", "card-top");
    top.append(el("h3", null, c.title));
    n.append(top);
    if (c.why_it_matters) n.append(el("p", "card-why", trim(c.why_it_matters, 190)));

    const meta = el("div", "meta");
    const pill = (t, cls) => meta.append(el("span", "pill " + (cls || ""), t));
    pill(TIME_LABEL[c.estimated_human_time] || "5 min", "time");
    if (c.priority === "BLOCKING_NOW") pill("blocking now", "blocking");
    if (c.priority === "BLOCKING_LATER") pill("blocking later", "later");
    if (c.reviewers_required > 1) pill(`${c.response_count}/${c.reviewers_required} reviews`);
    if (c.blinded) pill("blinded", "blind");
    if (c.artifact_count > 0) pill(`${c.artifact_count} artifact${c.artifact_count > 1 ? "s" : ""}`);
    if (c.visibility !== "PROJECT_COLLABORATOR") pill(c.visibility.toLowerCase().replace(/_/g, " "));
    n.append(meta);

    n.onclick = () => openSheet(c);
    n.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSheet(c); } };
    return n;
  }

  // ---- detail sheet -------------------------------------------------------

  async function openSheet(c) {
    open = c;
    pending = null;
    openedAt = Date.now();
    const box = $("sheet-content");
    box.textContent = "";

    box.append(el("h2", null, c.title));

    const block = (k, v, cls) => {
      if (!v) return;
      const b = el("div", "block" + (cls ? " " + cls : ""));
      b.append(el("div", "block-k", k), el("div", "block-v", v));
      box.append(b);
    };

    block("The question", c.question);
    block("Why it matters", c.why_it_matters);
    block("Affects", c.affects);
    block("If approved", c.if_approved);
    block("If revised", c.if_revised);

    // Hidden when the card is configured to withhold it, because a stated
    // recommendation is the strongest anchor in the whole UI.
    if (c.recommendation && !c.hide_recommendation) {
      block("Recommendation — not a decision", c.recommendation, "rec");
    } else if (c.hide_recommendation) {
      block("Recommendation", "Withheld for this card to avoid anchoring your judgment.", "rec");
    }

    // Artifacts, pinned to a commit and a content hash so the card names the
    // exact bytes it is about.
    const { data: arts } = await sb.from("decision_artifacts")
      .select("*").eq("decision_id", c.decision_id);
    if (arts && arts.length) {
      const b = el("div", "block");
      b.append(el("div", "block-k", "Artifacts"));
      const list = el("div", "artifacts");
      arts.forEach((a) => {
        const row = el("div", "artifact");
        row.append(el("span", "k", a.kind));
        const bits = [a.label, a.path, a.commit_hash && `@${a.commit_hash.slice(0, 10)}`,
                      a.content_sha256 && `sha256:${a.content_sha256.slice(0, 12)}…`]
          .filter(Boolean).join("  ");
        row.append(el("span", null, bits));
        if (a.external_url) {
          const link = el("a", null, "open");
          link.href = a.external_url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          row.append(link);
        }
        list.append(row);
      });
      b.append(list);
      box.append(b);
    }

    // Peers' responses, only when not blinded. A blinded card does not even ask.
    if (c.reviewers_required > 1 && !c.blinded) {
      const { data: rs } = await sb.from("decision_responses")
        .select("decision_value, rationale, confidence, submitted_at")
        .eq("decision_id", c.decision_id);
      if (rs && rs.length) {
        const b = el("div", "block");
        b.append(el("div", "block-k", `Responses so far (${rs.length}/${c.reviewers_required})`));
        rs.forEach((r) => {
          b.append(el("div", "provenance", `${r.decision_value} · ${r.confidence}\n${r.rationale}`));
        });
        box.append(b);
      }
    } else if (c.blinded) {
      block("Blinded review",
        `This card needs ${c.reviewers_required} independent reviews. Other ` +
        `reviewers' answers stay hidden until the card closes, so your judgment ` +
        `is formed without seeing theirs.`);
    }

    // Provenance. A decision detached from the revision and commit it was made
    // against cannot be interpreted later.
    const prov = [
      c.world_id && `world        ${c.world_id}`,
      c.task_revision && `task         ${c.task_revision}`,
      c.environment_revision && `environment  ${c.environment_revision}`,
      c.commit_hash && `commit       ${c.commit_hash.slice(0, 12)}`,
      `key          ${c.decision_key}`,
      `version      ${c.current_version}`,
      `visibility   ${c.visibility}`,
    ].filter(Boolean).join("\n");
    const pb = el("div", "block");
    pb.append(el("div", "block-k", "Provenance"), el("div", "provenance", prov));
    box.append(pb);

    box.append(controls(c));
    $("sheet").hidden = false;
  }

  function controls(c) {
    const wrap = el("div", "controls");
    const multi = c.reviewers_required > 1;

    const choices = el("div", "choices");
    const buttons = {};
    VALUES.forEach((v) => {
      const b = el("button", "choice");
      b.append(el("span", null, LABELS[v]));
      const k = Object.keys(KEYMAP).find((key) => KEYMAP[key] === v);
      b.append(Object.assign(el("kbd", null, k.toUpperCase())));
      b.onclick = () => choose(v, buttons, note);
      buttons[v] = b;
      choices.append(b);
    });
    wrap.append(choices);

    const note = el("div");
    note.hidden = true;
    const warn = el("div", "danger-note");
    const ta = el("textarea");
    ta.id = `rationale-${c.decision_id}`;
    ta.placeholder = "Why? This is the part that is worth keeping — a decision without a reason gets re-litigated or quietly reversed.";
    const label = el("label", null, "Rationale (required)");
    label.htmlFor = ta.id;
    const submit = el("button", "primary");

    note.append(warn, label, ta, submit);
    wrap.append(note);

    function choose(v, btns, panel) {
      pending = v;
      Object.entries(btns).forEach(([k, b]) => b.classList.toggle("is-on", k === v));
      panel.hidden = false;
      // Confirmation is not skipped for the high-impact answers, per the
      // instruction not to trade confirmation for speed on those.
      const heavy = v === "REJECTED" || v === "FRAMING_WRONG";
      warn.hidden = !heavy;
      warn.textContent = heavy
        ? `${LABELS[v]} is high-impact: it tells the team the work or its framing has to change. ` +
          `Say what is wrong so the next attempt is not a guess.`
        : "";
      submit.textContent = multi
        ? `Submit ${LABELS[v].toLowerCase()} as one of ${c.reviewers_required} reviews`
        : `${LABELS[v]} this decision`;
      ta.focus();
    }

    submit.onclick = async () => {
      const rationale = ta.value.trim();
      if (!rationale) { toast("A rationale is required.", true); ta.focus(); return; }
      submit.disabled = true;
      const secs = Math.round((Date.now() - openedAt) / 1000);
      try {
        if (multi) {
          const { error } = await sb.rpc("submit_response", {
            p_decision_id: c.decision_id, p_value: pending,
            p_rationale: rationale, p_confidence: "medium", p_duration_seconds: secs,
          });
          if (error) throw error;
          toast("Response submitted.");
        } else {
          const { error } = await sb.rpc("resolve_decision", {
            p_decision_id: c.decision_id, p_value: pending,
            p_rationale: rationale, p_expected_version: c.current_version,
          });
          if (error) throw error;
          toast(`${LABELS[pending]}.`);
        }
        closeSheet();
        await refresh();
        goNext();
      } catch (e) {
        toast(e.message || String(e), true);
        submit.disabled = false;
      }
    };

    return wrap;
  }

  function closeSheet() { $("sheet").hidden = true; open = null; pending = null; }

  function goNext() {
    const order = { BLOCKING_NOW: 0, BLOCKING_LATER: 1, NON_BLOCKING: 2 };
    const next = [...decisions].sort((a, b) =>
      (order[a.priority] - order[b.priority]) ||
      ((TIME_MIN[a.estimated_human_time] || 5) - (TIME_MIN[b.estimated_human_time] || 5))
    )[0];
    if (next) openSheet(next);
  }

  // ---- re-verification ----------------------------------------------------

  function renderReverify() {
    const box = $("reverify-list");
    box.textContent = "";
    if (!reverifications.length) {
      box.append(el("p", "empty", "Nothing awaiting acceptance."));
      return;
    }
    reverifications.forEach((r) => {
      const n = el("div", "card p-BLOCKING_LATER");
      n.append(el("h3", null, r.question));
      if (r.implementation_note) n.append(el("p", "card-why", r.implementation_note));
      const meta = el("div", "meta");
      if (r.implementation_commit) meta.append(el("span", "pill", `commit ${r.implementation_commit.slice(0, 10)}`));
      if (r.implementation_pr) meta.append(el("span", "pill", `PR ${r.implementation_pr}`));
      if (r.requested_by_agent) meta.append(el("span", "pill", `requested by ${r.requested_by_agent}`));
      n.append(meta);

      if (me.role === "OWNER" || me.role === "RESEARCHER") {
        const row = el("div", "choices");
        ["ACCEPTED", "REJECTED"].forEach((verdict) => {
          const b = el("button", "choice", verdict === "ACCEPTED" ? "Accept" : "Does not match");
          b.onclick = async (e) => {
            e.stopPropagation();
            const note = prompt(
              verdict === "ACCEPTED"
                ? "What did you check? (recorded on the acceptance)"
                : "What does not match the approved decision?"
            );
            if (note === null) return;
            if (!note.trim()) return toast("A note is required.", true);
            const { error } = await sb.from("reverifications").update({
              status: verdict, accepted_by: me.id,
              accepted_at: new Date().toISOString(), verdict_note: note.trim(),
            }).eq("reverification_id", r.reverification_id);
            error ? toast(error.message, true) : toast(verdict === "ACCEPTED" ? "Accepted." : "Sent back.");
            refresh();
          };
          row.append(b);
        });
        n.append(row);
      }
      box.append(n);
    });
  }

  function renderHistory() {
    const box = $("history-list");
    box.textContent = "";
    if (!resolved.length) { box.append(el("p", "empty", "No resolved cards yet.")); return; }
    resolved.forEach((c) => {
      const n = el("div", "card");
      n.append(el("h3", null, c.title));
      if (c.decision_rationale) n.append(el("p", "card-why", c.decision_rationale));
      const meta = el("div", "meta");
      meta.append(el("span", "pill", c.status));
      if (c.resolved_at) meta.append(el("span", "pill", new Date(c.resolved_at).toLocaleDateString()));
      if (c.source !== "cloud") meta.append(el("span", "pill", c.source));
      n.append(meta);
      box.append(n);
    });
  }

  // ---- chrome -------------------------------------------------------------

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isError ? " is-error" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 2800);
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeSheet();
    const tab = e.target.closest(".tab");
    if (tab) {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      ["inbox", "reverify", "history"].forEach((v) => {
        $("view-" + v).hidden = v !== tab.dataset.view;
      });
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closeSheet();
    // Never hijack a key while someone is typing a rationale.
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "n") { e.preventDefault(); return open ? (closeSheet(), goNext()) : goNext(); }
    if (open && KEYMAP[k]) {
      e.preventDefault();
      const btns = $("sheet-content").querySelectorAll(".choice");
      const idx = VALUES.indexOf(KEYMAP[k]);
      if (btns[idx]) btns[idx].click();
    }
  });

  // Primary path: email + a shared team code, which signs in immediately.
  //
  // Why a code rather than open auto-sign-in: this page is on a public URL, and
  // resolving a decision writes to an append-only audit log that cannot be
  // edited or deleted afterwards, even by the owner. Without a gate, a stranger
  // who guessed a cofounder's address could enter a judgment that is then
  // permanently indistinguishable from a real one in the research record. The
  // code costs one entry per device and removes that.
  //
  // It is deliberately NOT a per-person secret. It identifies the team; the
  // email identifies the person, which is what the audit trail records.
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("email").value.trim();
    const code = $("code").value;
    const btn = $("login-btn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    const { error } = await sb.auth.signInWithPassword({ email, password: code });
    btn.disabled = false;
    btn.textContent = "Sign in";
    if (error) {
      // Deliberately does not distinguish "wrong code" from "unknown email":
      // telling an anonymous visitor which addresses are authorized is a free
      // list of who to impersonate.
      return showGate(
        "That email and code combination was not accepted. Check the code, or " +
        "ask the project owner whether your address has been authorized.",
        true
      );
    }
    // onAuthStateChange takes it from here and runs the profile gate.
  });

  // Fallback: magic link. Kept because the code can be rotated or forgotten,
  // but it depends on the project's redirect allowlist being configured and on
  // the mailer's hourly quota, so it is the secondary path rather than the
  // primary one.
  $("magic-btn").addEventListener("click", async () => {
    const email = $("email").value.trim();
    if (!email) {
      return showGate("Enter your email first, then request a link.", true);
    }
    const btn = $("magic-btn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href.split("#")[0] },
    });
    btn.disabled = false;
    btn.textContent = "Forgot the code? Email me a link instead";
    if (error) {
      return showGate(
        error.message.toLowerCase().includes("rate")
          ? "The project's hourly email quota is used up. Use the team access code instead."
          : error.message,
        true
      );
    }
    showGate(
      `If ${email} is authorized, a sign-in link is on its way. The link only ` +
      `works for an authorized address.`
    );
  });

  $("logout").addEventListener("click", async () => {
    await sb.auth.signOut();
    location.reload();
  });

  boot();
})();
