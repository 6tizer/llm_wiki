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

export type ProfileSecretBackend = "file" | "keychain"

export interface ProfileSecretBackendResult {
  backend: ProfileSecretBackend
}

export interface ProfileSecretBackendSetRequest {
  backend: ProfileSecretBackend
}

/** Writes a raw profile secret to the active credential store and returns only its opaque reference. */
export function profileSecretWrite(
  request: ProfileSecretWriteRequest,
): Promise<ProfileSecretWriteResult> {
  return invoke<ProfileSecretWriteResult>("profile_secret_write", { request })
}

/** Deletes a profile secret reference from credential stores without exposing the value. */
export function profileSecretDelete(
  request: ProfileSecretDeleteRequest,
): Promise<ProfileSecretDeleteResult> {
  return invoke<ProfileSecretDeleteResult>("profile_secret_delete", { request })
}

/** Returns the active profile secret storage backend without exposing secret values. */
export function profileSecretBackendGet(): Promise<ProfileSecretBackendResult> {
  return invoke<ProfileSecretBackendResult>("profile_secret_backend_get")
}

/** Switches the active profile secret storage backend while preserving stored file secrets. */
export function profileSecretBackendSet(
  request: ProfileSecretBackendSetRequest,
): Promise<ProfileSecretBackendResult> {
  return invoke<ProfileSecretBackendResult>("profile_secret_backend_set", { request })
}
