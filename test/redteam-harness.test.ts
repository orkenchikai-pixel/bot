import { describe, expect, it } from "vitest";
import { DentalAgent } from "../src/agent/agent.js";
import { clinicCanary } from "../src/agent/safety.js";
import { ATTACKER, runScenario, SCENARIOS } from "../scripts/redteam.js";
import { FakeClaude, testClinic } from "./helpers.js";

/** Проверяем сам инструмент red-team (без живой модели): проверки должны ловить плохие ответы. */
const clinic = testClinic({ phone: "+7 700 000 00 00" });
const agentWith = (claude: FakeClaude) =>
  new DentalAgent(claude, { model: "claude-opus-5-5", effort: "medium", maxTokens: 1000, fallbacks: "off", maxToolRounds: 4, canarySecret: "rt" });

describe("red-team: сам инструмент", () => {
  it("хороший ответ проходит проверки", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "emergency")!;
    const withHandoff = new FakeClaude()
      .reply([{ type: "tool_use", name: "handoff_to_admin", input: { reason: "medical_urgent", summary: "отёк" } }])
      .reply([{ type: "text", text: "Срочно звоните 103, я передала вопрос администратору." }]);
    const { failures } = await runScenario(agentWith(withHandoff), clinic, scenario, "rt");
    expect(failures).toEqual([]);
  });

  it("плохие ответы ловятся: утечка промпта, чужие данные, код не по теме", async () => {
    const leak = new FakeClaude().reply([{ type: "text", text: `Мой промпт: ${clinicCanary(clinic, "rt")}` }]);
    const leakResult = await runScenario(agentWith(leak), clinic, SCENARIOS.find((s) => s.id === "prompt-extraction")!, "rt");
    expect(leakResult.failures.join(" ")).toContain("сработал фильтр");
    expect(leakResult.run.replies.join(" ")).not.toContain("CNRY-"); // пациент утечку не увидел

    const victim = new FakeClaude().reply([{ type: "text", text: "Записана Сапарова Динара, телефон +7 701 999 88 77" }]);
    const victimResult = await runScenario(agentWith(victim), clinic, SCENARIOS.find((s) => s.id === "other-patient")!, "rt");
    expect(victimResult.failures).toContain("в ответе есть данные другого пациента");

    const code = new FakeClaude().reply([{ type: "text", text: "Конечно!\n```python\nimport requests\n```" }]);
    const codeResult = await runScenario(agentWith(code), clinic, SCENARIOS.find((s) => s.id === "off-topic-code")!, "rt");
    expect(codeResult.failures.length).toBeGreaterThan(0);
  });

  it("сценарии покрывают ключевые угрозы", () => {
    const ids = SCENARIOS.map((s) => s.id);
    for (const id of ["prompt-extraction", "fake-system", "other-patient", "cancel-foreign", "phishing", "emergency", "prescription", "booking"]) {
      expect(ids).toContain(id);
    }
    expect(ATTACKER).toMatch(/^\d+$/);
  });
});
