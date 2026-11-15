// Store (Stars) host interface: the platform side of format/LUAU_API.md "Store". The game keeps an
// owned/pending cache loaded at boot; prompt() resolves asynchronously and `store.purchased` fires on the
// next tick after it resolves.
import type { Manifest } from "@dreamsy/format";

export type StoreItem = Manifest["store"][number];
export interface StorePurchase { itemId: string; purchaseId: string }

export interface StoreHost {
  /** Pass ids the player owns. */
  owned(): Promise<string[]>;
  /** Consumables bought but not yet consumed. */
  pending(): Promise<StorePurchase[]>;
  /** Show the purchase sheet; null when cancelled / not bought. */
  prompt(itemId: string): Promise<StorePurchase | null>;
  /** Mark a consumable as granted. Idempotent. */
  consume(purchaseId: string): Promise<void>;
}

/**
 * Deterministic in-memory store for Node, tests, playtests and the dev page without an API:
 * everything is purchasable for free, ids are mem_1, mem_2, ... Passes can be bought once.
 */
export class MemoryStoreHost implements StoreHost {
  readonly passes = new Set<string>();
  readonly unconsumed: StorePurchase[] = [];
  readonly purchases: StorePurchase[] = [];
  private next = 1;

  constructor(private items: readonly StoreItem[], init: { owned?: string[]; pending?: StorePurchase[] } = {}) {
    for (const id of init.owned ?? []) this.passes.add(id);
    this.unconsumed.push(...(init.pending ?? []));
  }

  async owned() { return [...this.passes]; }
  async pending() { return this.unconsumed.map((p) => ({ ...p })); }

  async prompt(itemId: string): Promise<StorePurchase | null> {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return null;
    if (item.kind === "pass" && this.passes.has(itemId)) return null;
    const p = { itemId, purchaseId: `mem_${this.next++}` };
    this.purchases.push(p);
    if (item.kind === "pass") this.passes.add(itemId);
    else this.unconsumed.push(p);
    return { ...p };
  }

  async consume(purchaseId: string) {
    const i = this.unconsumed.findIndex((p) => p.purchaseId === purchaseId);
    if (i >= 0) this.unconsumed.splice(i, 1);
  }
}
