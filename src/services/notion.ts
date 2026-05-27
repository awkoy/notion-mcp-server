import { Client } from "@notionhq/client";
import { authProvider } from "./auth.js";

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken || cachedClient === null) {
    const fresh = new Client({
      auth: token,
      notionVersion: "2025-09-03",
    });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}
