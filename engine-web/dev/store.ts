// Dev-page store host backed by the Dreamsy API (?api=&game=), with a minimal purchase sheet.
//   GET  /v1/games/:id/store            → { items, owned: { passes, unconsumed: [{purchaseId, itemId}] } }
//   GET  /v1/me/wallet                  → { wallet: { balance } }
//   POST /v1/games/:id/store/purchase   { itemId, idempotencyKey } → 201/200 { purchase, balance } | 402 | 409
//   POST /v1/games/:id/store/consume    { purchaseId } → 200 | 409 (already consumed: fine, idempotent)
import type { StoreHost, StoreItem, StorePurchase } from "../core/index.js";

export class ApiStoreHost implements StoreHost {
  private snapshot: Promise<{ passes: string[]; unconsumed: StorePurchase[] }> | null = null;

  constructor(
    private api: string,
    private gameId: string,
    private token: string,
    private items: readonly StoreItem[],
    private container: HTMLElement,
    /** Called after a successful purchase (the host app refreshes its wallet). */
    private onPurchase?: (itemId: string, balance: number | undefined) => void,
  ) {
    this.api = api.replace(/\/$/, "");
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  }

  private load() {
    this.snapshot ??= this.call("GET", `/v1/games/${encodeURIComponent(this.gameId)}/store`).then(({ status, data }) => {
      if (status !== 200) throw new Error(`GET store: ${status} ${data?.error ?? ""}`);
      return { passes: data.owned?.passes ?? [], unconsumed: data.owned?.unconsumed ?? [] };
    });
    return this.snapshot;
  }

  async owned() { return (await this.load()).passes; }
  async pending() { return (await this.load()).unconsumed; }

  async prompt(itemId: string): Promise<StorePurchase | null> {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return null;
    const wallet = await this.call("GET", "/v1/me/wallet").catch(() => null);
    const balance: number | undefined = wallet?.status === 200 ? wallet.data.wallet.balance : undefined;
    return new Promise((resolve) => {
      const sheet = new PurchaseSheet(this.container, item, balance);
      sheet.onCancel = () => { sheet.close(); resolve(null); };
      sheet.onBuy = async () => {
        sheet.busy(true);
        const key = crypto.randomUUID();
        const r = await this.call("POST", `/v1/games/${encodeURIComponent(this.gameId)}/store/purchase`, { itemId, idempotencyKey: key }).catch((e) => ({ status: 0, data: { error: String(e) } }));
        if (r.status === 200 || r.status === 201) {
          sheet.close();
          this.snapshot = null; // owned passes changed
          this.onPurchase?.(r.data.purchase.itemId, typeof r.data.balance === "number" ? r.data.balance : undefined);
          resolve({ itemId: r.data.purchase.itemId, purchaseId: r.data.purchase.id });
        } else if (r.status === 409) {
          sheet.message("You already own this.");
          sheet.busy(false, true);
        } else if (r.status === 402) {
          sheet.message(`Not enough coins${r.data?.balance !== undefined ? ` (you have ${r.data.balance.toLocaleString()} coins)` : ""}.`);
          sheet.busy(false, true);
        } else {
          sheet.message(`Purchase failed (${r.status}). ${r.data?.error ?? ""}`);
          sheet.busy(false);
        }
      };
    });
  }

  async consume(purchaseId: string) {
    const r = await this.call("POST", `/v1/games/${encodeURIComponent(this.gameId)}/store/consume`, { purchaseId });
    if (r.status !== 200 && r.status !== 409) throw new Error(`consume: ${r.status} ${r.data?.error ?? ""}`);
  }
}

/** Bottom sheet: item name, description, price, balance, Buy / Cancel. */
class PurchaseSheet {
  onBuy = () => {};
  onCancel = () => {};
  private root: HTMLDivElement;
  private msg: HTMLDivElement;
  private buy: HTMLButtonElement;

  constructor(container: HTMLElement, item: StoreItem, balance: number | undefined) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "absolute", inset: "0", zIndex: "200000", display: "flex", alignItems: "flex-end", justifyContent: "center",
      background: "rgba(0,0,0,0.45)", font: "16px system-ui, -apple-system, sans-serif", color: "#fff",
    });
    const card = document.createElement("div");
    Object.assign(card.style, { background: "#1c1f2b", borderRadius: "18px 18px 0 0", padding: "20px 24px 28px", width: "min(440px, 100%)", boxShadow: "0 -8px 30px rgba(0,0,0,0.4)" });
    const kind = item.kind === "pass" ? "Pass · yours forever" : "Consumable";
    card.innerHTML = `
      <div style="font-size:13px;opacity:.6;text-transform:uppercase;letter-spacing:.06em">${esc(kind)}</div>
      <div style="font-size:22px;font-weight:700;margin:4px 0 6px">${esc(item.name)}</div>
      <div style="opacity:.8;margin-bottom:16px">${esc(item.description ?? "")}</div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px">
        <span style="font-size:20px;font-weight:700;color:#ffcd75">${item.price.toLocaleString()} coins</span>
        <span style="opacity:.7">Balance: ${balance === undefined ? "?" : `${balance.toLocaleString()} coins`}</span>
      </div>`;
    this.msg = document.createElement("div");
    Object.assign(this.msg.style, { color: "#ff8a80", minHeight: "20px", marginBottom: "8px" });
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "12px" });
    const cancel = button("Cancel", "#333a4d");
    this.buy = button(`Buy for ${item.price.toLocaleString()} coins`, "#38b764");
    cancel.onclick = () => this.onCancel();
    this.buy.onclick = () => this.onBuy();
    row.append(cancel, this.buy);
    card.append(this.msg, row);
    this.root.append(card);
    this.root.addEventListener("pointerdown", (e) => { if (e.target === this.root) this.onCancel(); });
    container.append(this.root);
  }

  message(t: string) { this.msg.textContent = t; }
  busy(b: boolean, disableBuy = false) {
    this.buy.disabled = b || disableBuy;
    this.buy.style.opacity = this.buy.disabled ? "0.5" : "1";
  }
  close() { this.root.remove(); }
}

function button(text: string, bg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  Object.assign(b.style, { flex: "1", padding: "14px", border: "none", borderRadius: "12px", background: bg, color: "#fff", font: "700 16px system-ui, sans-serif", cursor: "pointer" });
  return b;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
