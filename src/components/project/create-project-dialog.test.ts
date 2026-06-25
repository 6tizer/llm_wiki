import { describe, expect, it } from "vitest"
import { validateCreateProjectInput } from "./create-project-dialog"

describe("validateCreateProjectInput", () => {
  it("requires both project name and parent directory", () => {
    expect(validateCreateProjectInput("", "/tmp", "English")).toBe(
      "project.errorNameRequired",
    )
    expect(validateCreateProjectInput("Wiki", "", "English")).toBe(
      "project.errorNameRequired",
    )
  })

  it("requires an explicit output language", () => {
    expect(validateCreateProjectInput("Wiki", "/tmp", "")).toBe(
      "project.errorLanguageRequired",
    )
  })

  it("accepts complete project input", () => {
    expect(validateCreateProjectInput("Wiki", "/tmp", "English")).toBeNull()
  })
})
