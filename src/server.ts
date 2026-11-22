import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { NONCE, secureHeaders } from "hono/secure-headers";
import { createAdminRoutes, type AdminDeps } from "./admin/routes.js";
import type { ClinicRegistry } from "./clinic/registry.js";
import { errorMessage, log } from "./log.js";
import type { Dispatcher } from "./messaging/dispatcher.js";
import { DateTime } from "./scheduling/time.js";
import { parseWebhookPayload, verifySignature } from "./whatsapp/webhook.js";

export interface ServerDeps {
  registry: ClinicRegistry;
  dispatcher: Dispatcher;
  whatsapp: { verifyToken?: string; appSecret?: string };
  admin: Omit<AdminDeps, "clientIp">;
  simulator?: Hono;
  /** Сервер за обратным прокси: IP клиента — из X-Forwarded-For. */
  trustProxy?: boolean;
}

/** IP клиента для лимитов. Заголовкам прокси верим только при TRUST_PROXY=true — иначе их легко подделать. */
export function clientIpResolver(trustProxy: boolean) {
  return (c: Context): string => {
    if (trustProxy) {
      const forwarded = c.req.header("x-forwarded-for");
      if (forwarded) return forwarded.split(",")[0]!.trim();
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };
}

const tooLarge = (c: Context) => c.json({ error: "payload too large" }, 413);

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  // Заголовки безопасности: запрет встраивания во фреймы, строгий CSP с nonce, без утечки Referer.
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: [NONCE],
        styleSrc: [NONCE],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: "no-referrer",
      xFrameOptions: "DENY",
      crossOriginResourcePolicy: "same-origin",
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    }),
  );
  // Ограничение размера запросов — защита от исчерпания памяти.
  app.use("/webhook/*", bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }));
  app.use("/admin/*", bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }));
  app.use("/simulator/*", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }));

  app.onError((err, c) => {
    log.error("Необработанная ошибка HTTP", { path: c.req.path, error: errorMessage(err) });
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.get("/", (c) => c.text("ИИ-администратор стоматологии работает. Проверка: /health"));
  app.get("/health", (c) => c.json({ ok: true }));

  // Meta проверяет вебхук GET-запросом с hub.challenge при настройке в кабинете разработчика.
  app.get("/webhook/whatsapp", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && challenge && deps.whatsapp.verifyToken && token === deps.whatsapp.verifyToken) {
      log.info("Вебхук WhatsApp подтверждён");
      return c.text(challenge.slice(0, 200));
    }
    log.warn("Неудачная проверка вебхука WhatsApp (проверьте WHATSAPP_VERIFY_TOKEN)");
    return c.text("Forbidden", 403);
  });

  app.post("/webhook/whatsapp", async (c) => {
    if (!deps.whatsapp.appSecret) {
      log.error("WHATSAPP_APP_SECRET не задан — входящие сообщения отклоняются");
      return c.text("Server is not configured", 503);
    }
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!verifySignature(raw, c.req.header("x-hub-signature-256"), deps.whatsapp.appSecret)) {
      log.warn("Вебхук с неверной подписью отклонён");
      return c.text("Invalid signature", 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return c.text("Bad JSON", 400);
    }
    for (const msg of parseWebhookPayload(payload)) {
      const clinic = deps.registry.getByPhoneNumberId(msg.phoneNumberId);
      if (!clinic) {
        log.warn("Сообщение на номер, не привязанный ни к одной клинике", { phoneNumberId: msg.phoneNumberId });
        continue;
      }
      try {
        // Сообщение сохраняется в БД сразу, а ответ готовится в фоне — Meta ждёт 200 быстро.
        await deps.dispatcher.handleInbound({
          clinicId: clinic.id,
          phone: msg.from,
          profileName: msg.profileName,
          waMessageId: msg.waMessageId,
          text: msg.text,
          image: msg.image,
          replyId: msg.replyId,
          sentAt: msg.timestamp ? DateTime.fromSeconds(msg.timestamp) : undefined,
        });
      } catch (err) {
        log.error("Не удалось принять сообщение", { error: errorMessage(err) });
      }
    }
    return c.text("OK");
  });

  app.route("/admin", createAdminRoutes({ ...deps.admin, clientIp: clientIpResolver(deps.trustProxy ?? false) }));
  if (deps.simulator) app.route("/simulator", deps.simulator);

  return app;
}
