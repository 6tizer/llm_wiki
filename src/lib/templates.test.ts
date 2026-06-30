import { describe, expect, it } from "vitest"
import { getTemplate, templates } from "./templates"

describe("project templates", () => {
  it("treats root index and overview pages as optional derived or user-authored assets", () => {
    for (const template of templates) {
      expect(template.schema).not.toContain(
        "Every entity and concept should appear in `wiki/index.md`",
      )
      expect(template.schema).toContain("Root `wiki/index.md` is optional")
      expect(template.schema).toContain(
        "overview | wiki/ | Optional project synthesis or user-authored summary",
      )
    }
  })

  it("keeps template lookup stable", () => {
    expect(getTemplate("general").id).toBe("general")
  })
})
