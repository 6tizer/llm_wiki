import { invoke } from "@tauri-apps/api/core"

export interface ProfileSecretWriteRequest {
  secretValue: string
}

export interface ProfileSecretWriteResult {
  secretRef: string
}

export interface ProfileSecretDeleteRequest {
  secretRef: string
}

export interface ProfileSecretDeleteResult {
  ok: boolean
}

/** Writes a raw profile secret to the OS credential store and returns only its opaque reference. */
export function profileSecretWrite(
  request: ProfileSecretWriteRequest,
): Promise<ProfileSecretWriteResult> {
  return invoke<ProfileSecretWriteResult>("profile_secret_write", { request })
}

/** Deletes a profile secret reference from the OS credential store without exposing the value. */
export function profileSecretDelete(
  request: ProfileSecretDeleteRequest,
): Promise<ProfileSecretDeleteResult> {
  return invoke<ProfileSecretDeleteResult>("profile_secret_delete", { request })
}
