import { isAsnManagedName } from "./asn.ts";
import type { CfClient, GatewayList, GatewayListItem, GatewayRule } from "./cf-client.ts";
import { isOwnedName } from "./cf-client.ts";

export function assertOwnedName(name: string, prefix: string): void {
  if (!isOwnedName(name, prefix)) {
    throw new Error(`refusing to mutate "${name}": name must start with "${prefix}"`);
  }
}

export function assertAsnListName(name: string): void {
  if (!isAsnManagedName(name)) {
    throw new Error(`refusing to mutate "${name}": ASN list name must start with AS<number>`);
  }
}

function parseCreatedList(result: unknown, fallbackName: string): GatewayList {
  if (
    typeof result === "object" &&
    result !== null &&
    "id" in result &&
    "name" in result &&
    typeof result.id === "string" &&
    typeof result.name === "string"
  ) {
    return { id: result.id, name: result.name };
  }
  throw new Error(`Cloudflare API POST /gateway/lists: missing list in result (${fallbackName})`);
}

export async function createGatewayList(
  client: CfClient,
  prefix: string,
  input: { name: string; description?: string; items?: GatewayListItem[] },
): Promise<GatewayList> {
  assertOwnedName(input.name, prefix);
  const envelope = await client.request("POST", "/gateway/lists", {
    name: input.name,
    description: input.description,
    type: "DOMAIN",
    items: input.items,
  });
  return parseCreatedList(envelope.result, input.name);
}

export async function createAsnGatewayList(
  client: CfClient,
  input: { name: string; description?: string; items?: GatewayListItem[] },
): Promise<GatewayList> {
  assertAsnListName(input.name);
  const envelope = await client.request("POST", "/gateway/lists", {
    name: input.name,
    description: input.description,
    type: "IP",
    items: input.items,
  });
  return parseCreatedList(envelope.result, input.name);
}

export async function patchGatewayList(
  client: CfClient,
  prefix: string,
  input: {
    id: string;
    name?: string;
    append?: GatewayListItem[];
    remove?: string[];
  },
): Promise<void> {
  const name = input.name ?? (await client.getList(input.id)).name;
  assertOwnedName(name, prefix);
  await client.request("PATCH", `/gateway/lists/${input.id}`, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    append: input.append,
    remove: input.remove,
  });
}

export async function patchAsnGatewayList(
  client: CfClient,
  input: {
    id: string;
    name?: string;
    append?: GatewayListItem[];
    remove?: string[];
  },
): Promise<void> {
  const current = await client.getList(input.id);
  assertAsnListName(current.name);
  if (current.type && current.type !== "IP") {
    throw new Error(`refusing to mutate "${current.name}": type is ${current.type}, expected IP`);
  }
  if (input.name !== undefined) assertAsnListName(input.name);
  await client.request("PATCH", `/gateway/lists/${input.id}`, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.append && input.append.length > 0 ? { append: input.append } : {}),
    ...(input.remove && input.remove.length > 0 ? { remove: input.remove } : {}),
  });
}

export async function upsertGatewayRule(
  client: CfClient,
  prefix: string,
  input: {
    id?: string;
    name: string;
    precedence: number;
    action: string;
    enabled?: boolean;
    filters?: string[];
    traffic?: string;
  },
): Promise<GatewayRule> {
  assertOwnedName(input.name, prefix);
  const body = {
    name: input.name,
    precedence: input.precedence,
    action: input.action,
    enabled: input.enabled ?? true,
    filters: input.filters,
    traffic: input.traffic,
  };
  const envelope = input.id
    ? await client.request("PUT", `/gateway/rules/${input.id}`, body)
    : await client.request("POST", "/gateway/rules", body);
  const result = envelope.result;
  if (
    typeof result === "object" &&
    result !== null &&
    "id" in result &&
    "name" in result &&
    typeof result.id === "string" &&
    typeof result.name === "string"
  ) {
    return { id: result.id, name: result.name };
  }
  return { id: input.id ?? "", name: input.name, precedence: input.precedence, action: input.action };
}
