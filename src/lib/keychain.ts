import { invoke } from "@tauri-apps/api/core";

export async function keychainSet(connectionId: string, password: string): Promise<void> {
  await invoke("keychain_set", { connectionId, password });
}

export async function keychainGet(connectionId: string): Promise<string> {
  return invoke<string>("keychain_get", { connectionId });
}

export async function keychainDelete(connectionId: string): Promise<void> {
  await invoke("keychain_delete", { connectionId });
}
