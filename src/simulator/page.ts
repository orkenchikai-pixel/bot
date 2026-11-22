/** Страница веб-симулятора: чат с ИИ-администратором без подключения WhatsApp. */
export const SIMULATOR_HTML = /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Симулятор чата клиники</title>
<style>
  :root {
    --bg: #eef1f4; --panel: #ffffff; --text: #1d2329; --muted: #6b7580; --border: #dde2e7;
    --mine: #d9fdd3; --theirs: #ffffff; --accent: #128c5e; --accent-text: #ffffff;
    --chat-bg: #efeae2; --note: #fff6d6; --note-text: #5c4a00; --danger: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1418; --panel: #182026; --text: #e6eaed; --muted: #94a0aa; --border: #2a343c;
      --mine: #144d37; --theirs: #202c33; --accent: #21a873; --accent-text: #06120d;
      --chat-bg: #0b1114; --note: #3a3216; --note-text: #f3e2a5; --danger: #ff8a80;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0 12px 0 0; }
  select, input, textarea, button { font: inherit; color: inherit; }
  select, input { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; min-width: 0; }
  button { border: 0; border-radius: 8px; padding: 7px 14px; cursor: pointer; background: var(--accent); color: var(--accent-text); font-weight: 600; }
  button.secondary { background: transparent; color: var(--text); border: 1px solid var(--border); font-weight: 500; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: calc(100vh - 58px); }
  #chat { display: flex; flex-direction: column; background: var(--chat-bg); min-height: 0; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
  .msg { max-width: min(560px, 85%); padding: 7px 10px; border-radius: 10px; white-space: normal; word-wrap: break-word; box-shadow: 0 1px 1px rgba(0,0,0,.08); }
  .mine { align-self: flex-end; background: var(--mine); border-top-right-radius: 2px; }
  .theirs { align-self: flex-start; background: var(--theirs); border-top-left-radius: 2px; }
  .system { align-self: center; background: var(--note); color: var(--note-text); font-size: 13px; border-radius: 8px; padding: 5px 10px; max-width: 90%; text-align: center; }
  .typing { color: var(--muted); font-style: italic; }
  .buttons { align-self: flex-start; display: flex; gap: 6px; flex-wrap: wrap; max-width: min(560px, 85%); }
  .buttons button { background: var(--theirs); }
  .buttons button:disabled { opacity: .5; cursor: default; }
  form { display: flex; gap: 8px; padding: 10px 12px; background: var(--panel); border-top: 1px solid var(--border); }
  textarea { flex: 1; resize: none; border: 1px solid var(--border); background: var(--bg); border-radius: 18px; padding: 8px 14px; height: 40px; max-height: 140px; }
  aside { background: var(--panel); border-left: 1px solid var(--border); overflow-y: auto; padding: 14px; }
  aside h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 6px 0 8px; }
  .card { border: 1px solid var(--border); border-radius: 10px; padding: 9px 10px; margin-bottom: 8px; font-size: 13px; white-space: pre-wrap; }
  .empty { color: var(--muted); font-size: 13px; }
  #paused { display: none; gap: 8px; align-items: center; justify-content: center; padding: 8px; background: var(--note); color: var(--note-text); font-size: 13px; }
  a { color: var(--accent); }
  @media (max-width: 760px) {
    header { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; padding: 10px 16px; }
    header h1 { grid-column: 1 / -1; }
    header label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--muted); }
    header label select, header label input { width: 100%; font-size: 15px; color: var(--text); }
    #reset { grid-column: 1 / -1; }
    main { display: block; height: auto; }
    #chat { height: 72vh; height: 72svh; }
    aside { border-left: 0; border-top: 1px solid var(--border); }
  }
</style>
</head>
<body>
<header>
  <h1>🦷 Симулятор чата</h1>
  <label>Клиника <select id="clinic"></select></label>
  <label>Номер <input id="phone" size="13" inputmode="numeric"></label>
  <label>Имя в профиле <input id="name" size="10" placeholder="необязательно"></label>
  <button class="secondary" id="reset" type="button">Новый диалог</button>
</header>
<main>
  <section id="chat">
    <div id="paused">Бот на паузе — сообщения уходят администратору. <button class="secondary" id="resume" type="button">Вернуть бота</button></div>
    <div id="messages"></div>
    <form id="form">
      <textarea id="text" placeholder="Сообщение от пациента…" aria-label="Сообщение от пациента"></textarea>
      <button type="submit">Отправить</button>
    </form>
  </section>
  <aside>
    <h2>Записи пациента</h2>
    <div id="appointments"><div class="empty">Пока нет</div></div>
    <h2>Уведомления администратору</h2>
    <div id="notifications"><div class="empty">Здесь появится то, что администратор получит в Telegram</div></div>
  </aside>
</main>
<script>
  // Ключ — во фрагменте адреса (#key=…): он не отправляется на сервер в URL и не попадает в логи.
  const key = new URLSearchParams(location.hash.slice(1)).get("key");
  const desktop = matchMedia("(min-width: 761px)").matches;
  const api = (path) => "/simulator/api/" + path;
  const authHeaders = key ? { "X-Simulator-Key": key } : {};
  const $ = (id) => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  const randomPhone = () => "7999" + String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
  $("phone").value = store.get("sim.phone") || randomPhone();
  $("name").value = store.get("sim.name") || "";

  function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
  function format(text) {
    return text.split(/(https?:\\/\\/[^\\s]+)/g).map((part, i) => {
      if (i % 2 === 1) { const u = esc(part); return '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>"; }
      return esc(part).replace(/\\*([^*\\n]+)\\*/g, "<b>$1</b>").replace(/(^|\\W)_([^_\\n]+)_(?=\\W|$)/g, "$1<i>$2</i>").replace(/~([^~\\n]+)~/g, "<s>$1</s>");
    }).join("").replace(/\\n/g, "<br>");
  }
  function add(kind, text) {
    const el = document.createElement("div");
    el.className = "msg " + kind;
    el.innerHTML = kind === "system" ? esc(text) : format(text);
    $("messages").appendChild(el);
    $("messages").scrollTop = $("messages").scrollHeight;
    return el;
  }
  function renderAppointments(list) {
    $("appointments").innerHTML = list.length ? "" : '<div class="empty">Пока нет</div>';
    for (const a of list) {
      const card = document.createElement("div");
      card.className = "card";
      card.textContent = "№" + a.id + " · " + a.when + "\\n" + a.service + " — " + a.doctor + "\\n" + a.patient + " · " + a.status;
      $("appointments").appendChild(card);
    }
  }
  function addNotifications(list) {
    if (!list.length) return;
    const box = $("notifications");
    if (box.querySelector(".empty")) box.innerHTML = "";
    for (const text of list) {
      const card = document.createElement("div");
      card.className = "card";
      card.textContent = text;
      box.prepend(card);
    }
  }
  function setPaused(paused) { $("paused").style.display = paused ? "flex" : "none"; }
  const conv = () => ({ clinicId: $("clinic").value, phone: $("phone").value.trim() });
  async function post(path, body) {
    const res = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("Ошибка " + res.status));
    return data;
  }

  function addButtons(buttons) {
    const row = document.createElement("div");
    row.className = "buttons";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary";
      btn.textContent = b.title;
      btn.addEventListener("click", () => {
        row.querySelectorAll("button").forEach((x) => (x.disabled = true));
        send(b.title, b.id);
      });
      row.appendChild(btn);
    }
    $("messages").appendChild(row);
    $("messages").scrollTop = $("messages").scrollHeight;
  }

  async function send(text, replyId) {
    add("mine", text);
    const typing = add("theirs typing", "печатает…");
    $("text").disabled = true;
    try {
      const data = await post("send", { ...conv(), text, replyId, name: $("name").value.trim() || undefined });
      typing.remove();
      for (const r of data.replies) {
        add("theirs", r.text);
        if (r.buttons && r.buttons.length) addButtons(r.buttons);
      }
      if (!data.replies.length && data.paused) add("system", "Сообщение передано администратору");
      addNotifications(data.notifications);
      renderAppointments(data.appointments);
      setPaused(data.paused);
    } catch (err) {
      typing.remove();
      add("system", "⚠️ " + err.message);
    } finally {
      $("text").disabled = false;
      if (desktop) $("text").focus();
    }
  }

  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("text").value.trim();
    if (!text) return;
    $("text").value = "";
    send(text);
  });
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); }
  });
  $("reset").addEventListener("click", async () => {
    try { await post("reset", conv()); } catch (err) { add("system", "⚠️ " + err.message); return; }
    $("messages").innerHTML = "";
    $("notifications").innerHTML = '<div class="empty">Здесь появится то, что администратор получит в Telegram</div>';
    renderAppointments([]);
    setPaused(false);
    add("system", "Новый диалог. Напишите, например: «Здравствуйте, сколько стоит чистка?»");
  });
  $("resume").addEventListener("click", async () => {
    try { await post("resume", conv()); setPaused(false); add("system", "Бот снова отвечает"); } catch (err) { add("system", "⚠️ " + err.message); }
  });
  $("phone").addEventListener("change", () => store.set("sim.phone", $("phone").value.trim()));
  $("name").addEventListener("change", () => store.set("sim.name", $("name").value.trim()));

  fetch(api("clinics"), { headers: authHeaders }).then((r) => {
    if (!r.ok) throw new Error();
    return r.json();
  }).then((clinics) => {
    for (const c of clinics) {
      const opt = document.createElement("option");
      opt.value = c.id; opt.textContent = c.name;
      $("clinic").appendChild(opt);
    }
    add("system", "Это тестовый чат с ИИ-администратором (отдельная база, WhatsApp не нужен). Напишите как пациент.");
    if (desktop) $("text").focus();
  }).catch(() => add("system", "⚠️ Не удалось загрузить список клиник"));
</script>
</body>
</html>`;
