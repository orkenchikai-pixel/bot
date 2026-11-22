import { IANAZone } from "luxon";
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "время в формате HH:MM");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата в формате YYYY-MM-DD");
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "только латиница в нижнем регистре, цифры, - и _");

/** Рабочий интервал врача: ["09:00", "14:00"]. Несколько интервалов в день = перерыв между ними. */
const interval = z
  .tuple([hhmm, hhmm])
  .refine(([start, end]) => start < end, "начало интервала должно быть раньше конца");

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const weekSchedule = z.object({
  mon: z.array(interval).optional(),
  tue: z.array(interval).optional(),
  wed: z.array(interval).optional(),
  thu: z.array(interval).optional(),
  fri: z.array(interval).optional(),
  sat: z.array(interval).optional(),
  sun: z.array(interval).optional(),
});

const service = z.object({
  id: slug,
  category: z.string().min(1),
  name: z.string().min(1),
  /** Цена в валюте клиники. По умолчанию показывается как «от …». */
  price_from: z.number().nonnegative(),
  /** Верхняя граница цены, если есть диапазон («15 000–25 000»). */
  price_to: z.number().nonnegative().optional(),
  /** true — точная цена без «от» (например, консультация). */
  price_fixed: z.boolean().default(false),
  /** Сколько минут занимает приём. Используется для поиска свободного времени. */
  duration_min: z.number().int().positive(),
  description: z.string().optional(),
  /** false — на услугу нельзя записаться напрямую (например, имплантация: сначала консультация). */
  bookable: z.boolean().default(true),
});

const doctor = z.object({
  id: slug,
  name: z.string().min(1),
  specialty: z.string().min(1),
  about: z.string().optional(),
  /** id услуг, которые выполняет врач, или ["*"] — все услуги, на которые можно записаться. */
  services: z.array(z.string()).min(1),
  schedule: weekSchedule,
  /** Отпуск, больничные и прочие выходные врача. */
  days_off: z.array(isoDate).default([]),
  active: z.boolean().default(true),
});

export const ClinicSchema = z
  .object({
    id: slug,
    name: z.string().min(1),
    timezone: z.string().refine((tz) => IANAZone.isValidZone(tz), "неизвестный часовой пояс IANA"),
    /** Как писать валюту в ответах: "₸", "₽", "сум", "сом". */
    currency: z.string().min(1),
    address: z.string().min(1),
    map_url: z.string().optional(),
    phone: z.string().optional(),
    working_hours_text: z.string().min(1),
    website: z.string().optional(),
    instagram: z.string().optional(),
    about: z.string().optional(),
    payment_methods: z.string().optional(),
    emergency_phone: z.string().default("103 или 112"),
    policies: z.array(z.string()).default([]),
    promotions: z.array(z.string()).default([]),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
    /** Дни, когда клиника закрыта целиком (праздники). */
    holidays: z.array(isoDate).default([]),

    booking: z
      .object({
        /** Шаг сетки записи в минутах. */
        slot_step_min: z.number().int().positive().default(30),
        /** Минимум минут от текущего момента до начала приёма. */
        min_notice_min: z.number().int().nonnegative().default(60),
        /** На сколько дней вперёд можно записаться. */
        horizon_days: z.number().int().positive().default(30),
        /** Сколько активных будущих записей может быть у одного номера. */
        max_active_per_patient: z.number().int().positive().default(3),
        /** Пациент может отменить/перенести запись не позднее чем за N часов (позже — через администратора). */
        change_deadline_hours: z.number().nonnegative().default(2),
        /** Сколько записей/отмен/переносов один номер может сделать за сутки (защита от злоупотреблений). */
        max_changes_per_day: z.number().int().positive().default(6),
      })
      .prefault({}),

    whatsapp: z.object({
      /** Phone number ID из Meta (WhatsApp Manager → API Setup). По нему вебхук понимает, какой это клиника. */
      phone_number_id: z.string().min(1),
      /** Имя переменной окружения с токеном доступа этой клиники. Если не задано — WHATSAPP_ACCESS_TOKEN. */
      access_token_env: z.string().optional(),
    }),

    notifications: z
      .object({
        /** chat_id в Telegram, куда слать уведомления о записях и передачах администратору. */
        telegram_chat_ids: z.array(z.string()).default([]),
        /** URL, на который отправляется JSON о каждом событии (для CRM, n8n, Make, Bitrix24 и т.п.). */
        webhook_url: z.url().optional(),
      })
      .prefault({}),

    reminders: z
      .object({
        enabled: z.boolean().default(true),
        hours_before: z.number().positive().default(24),
        /**
         * Утверждённый в Meta шаблон. Нужен, если пациент не писал больше 24 часов:
         * вне 24-часового окна WhatsApp разрешает бизнесу писать только шаблонами.
         * Параметры тела шаблона по порядку: {{1}} имя, {{2}} дата, {{3}} время, {{4}} врач, {{5}} клиника.
         */
        template_name: z.string().optional(),
        template_language: z.string().default("ru"),
      })
      .prefault({}),

    privacy: z
      .object({
        /**
         * explicit — до согласия пациента его сообщения не передаются ИИ (рекомендуется для медицинских данных);
         * notice — уведомление в первом сообщении, согласие — продолжением переписки;
         * off — согласие собирается иначе (например, подписано в клинике). Используйте только по совету юриста.
         */
        consent_mode: z.enum(["explicit", "notice", "off"]).default("explicit"),
        /** Меняйте версию при изменении политики — пациентов попросят дать согласие заново. */
        consent_version: z.string().min(1).default("1"),
        policy_url: z.url().optional(),
        /** Юрлицо — оператор персональных данных (ТОО/ИП/ООО). */
        operator_name: z.string().optional(),
        /** Свой текст запроса согласия вместо стандартного. */
        consent_text: z.string().optional(),
        /** Помечать каждое сообщение бота значком 🤖 (если юрист посчитает нужным маркировать каждый ответ ИИ). */
        ai_label_each_message: z.boolean().default(false),
      })
      .prefault({}),

    limits: z
      .object({
        /** Дневной бюджет на ИИ для клиники, USD. При превышении бот передаёт чаты администратору до конца дня. */
        daily_budget_usd: z.number().positive().default(15),
      })
      .prefault({}),

    admin: z
      .object({
        /** SHA-256 токена администратора этой клиники (npm run token). Такой токен видит данные только своей клиники. */
        token_sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/, "64 hex-символа (sha256)")
          .optional(),
      })
      .prefault({}),

    assistant: z
      .object({
        name: z.string().default("Администратор"),
        /** Дополнительные правила для ИИ именно этой клиники. */
        extra_instructions: z.string().optional(),
      })
      .prefault({}),

    services: z.array(service).min(1),
    doctors: z.array(doctor).min(1),
  })
  .superRefine((clinic, ctx) => {
    const serviceIds = new Set<string>();
    clinic.services.forEach((s, i) => {
      if (serviceIds.has(s.id)) {
        ctx.addIssue({ code: "custom", path: ["services", i, "id"], message: `повторяется id услуги "${s.id}"` });
      }
      serviceIds.add(s.id);
      if (s.price_to !== undefined && s.price_to < s.price_from) {
        ctx.addIssue({ code: "custom", path: ["services", i, "price_to"], message: "price_to меньше price_from" });
      }
    });
    const doctorIds = new Set<string>();
    clinic.doctors.forEach((d, i) => {
      if (doctorIds.has(d.id)) {
        ctx.addIssue({ code: "custom", path: ["doctors", i, "id"], message: `повторяется id врача "${d.id}"` });
      }
      doctorIds.add(d.id);
      d.services.forEach((sid, j) => {
        if (sid !== "*" && !serviceIds.has(sid)) {
          ctx.addIssue({ code: "custom", path: ["doctors", i, "services", j], message: `нет услуги с id "${sid}"` });
        }
      });
    });
  });

export type ClinicConfig = z.infer<typeof ClinicSchema>;
export type Service = ClinicConfig["services"][number];
export type Doctor = ClinicConfig["doctors"][number];
export type WeekSchedule = Doctor["schedule"];

/** Врачи, которые выполняют услугу (только активные). */
export function doctorsForService(clinic: ClinicConfig, serviceId: string): Doctor[] {
  return clinic.doctors.filter((d) => d.active && (d.services.includes("*") || d.services.includes(serviceId)));
}

export function findService(clinic: ClinicConfig, id: string): Service | undefined {
  return clinic.services.find((s) => s.id === id);
}

export function findDoctor(clinic: ClinicConfig, id: string): Doctor | undefined {
  return clinic.doctors.find((d) => d.id === id);
}
