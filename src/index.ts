// ─────────────────────────────────────────────────────────────
// @forjio/plugipay-js — embedded checkout widget for the browser.
//
// Usage (on the merchant's storefront checkout page):
//
//   import { PlugipayCheckout } from '@forjio/plugipay-js';
//
//   const checkout = new PlugipayCheckout({
//     sessionId: 'cs_abc',                // session the merchant pre-created
//     baseUrl:   'https://plugipay.com',  // or their self-hosted origin
//     container: '#plugipay-checkout',    // any selector or Element
//     onComplete: ({ sessionId }) => { window.location = '/thanks'; },
//     onError:    ({ message })   => { console.error(message); },
//   });
//   await checkout.mount();
//
// The widget fetches the public session state (methods, amount,
// branding), renders a method picker + "Pay" button styled to inherit
// the page's CSS vars, and drives the charge via the public charge
// endpoint. For method-specific next-steps (PayPal popup, QRIS wallet
// deep-link, VA instructions) it opens a modal drawer inside the
// merchant's page — the URL bar never leaves the storefront.
// ─────────────────────────────────────────────────────────────

interface PublicSessionDTO {
  session: {
    id: string;
    amount: number;
    currency: string;
    status: 'open' | 'completed' | 'pending_review' | 'expired' | 'canceled';
    expiresAt: string;
    successUrl: string;
    cancelUrl: string;
    lineItems: unknown;
  };
  methods: string[];
  catalog: { id: string; label: string; group: string; currency: string }[];
  branding: {
    brandName: string | null;
    brandLogoUrl: string | null;
    brandAccentColor: string | null;
    brandTagline: string | null;
  };
  checkoutTemplate?: {
    successMessage: string | null;
    showBusinessDetails: boolean;
    businessPhone: string | null;
    businessEmail: string | null;
    businessAddress: string | null;
  };
  activeAdapters: string[];
}

type ChargeResponse =
  | { kind: 'redirect'; redirectUrl: string }
  | { kind: 'instructions'; instructions: ManualInstructions };

interface ManualInstructions {
  heading: string;
  note: string | null;
  bankAccounts?: { bankName: string; accountNumber: string; accountHolder: string }[];
  qrImageUrl?: string | null;
  amount: number;
  currency: string;
}

export interface CheckoutOptions {
  /** CheckoutSession id (cs_...). The merchant creates this server-side
   *  before mounting the widget. */
  sessionId: string;
  /** Where to render. Accepts a CSS selector or an Element. */
  container: string | HTMLElement;
  /** Plugipay origin. Defaults to https://plugipay.com. */
  baseUrl?: string;
  /** Called when payment succeeds and session is completed. */
  onComplete?: (p: { sessionId: string }) => void;
  /** Called on a fatal render or charge error. */
  onError?: (p: { message: string; code?: string }) => void;
  /** Called right before the widget redirects the browser for a handoff
   *  (PayPal popup, hosted instructions). Return false to keep the
   *  merchant's page on screen. */
  onBeforeRedirect?: (p: { url: string }) => boolean | void;
}

const GROUP_LABEL: Record<string, string> = {
  qr: 'Scan to pay',
  ewallet: 'E-wallet',
  va: 'Virtual account',
  debit: 'Direct debit',
  card: 'Card',
  retail: 'Over-the-counter',
  bnpl: 'Pay later',
  paypal: 'PayPal',
  offline: 'Offline',
};

export class PlugipayCheckout {
  private readonly opts: Required<Pick<CheckoutOptions, 'sessionId' | 'container' | 'baseUrl'>> & CheckoutOptions;
  private root: HTMLElement | null = null;
  private selected: string | null = null;
  private session: PublicSessionDTO | null = null;

  constructor(opts: CheckoutOptions) {
    this.opts = {
      baseUrl: 'https://plugipay.com',
      ...opts,
    } as Required<Pick<CheckoutOptions, 'sessionId' | 'container' | 'baseUrl'>> & CheckoutOptions;
  }

  async mount(): Promise<void> {
    const container = typeof this.opts.container === 'string'
      ? document.querySelector<HTMLElement>(this.opts.container)
      : this.opts.container;
    if (!container) {
      this.fail('container not found');
      return;
    }
    this.root = container;
    this.renderLoading();
    try {
      const dto = await this.fetchSession();
      this.session = dto;
      this.selected = dto.methods[0] ?? null;
      if (dto.session.status !== 'open') {
        this.renderTerminal(dto.session.status);
        return;
      }
      this.renderActive();
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private async fetchSession(): Promise<PublicSessionDTO> {
    const res = await fetch(`${this.opts.baseUrl}/api/v1/public/checkout/sessions/${this.opts.sessionId}`);
    if (!res.ok) throw new Error(`Could not load checkout (${res.status})`);
    const body = await res.json() as { data: PublicSessionDTO };
    return body.data;
  }

  // ─── Rendering ─────────────────────────────────────────────

  private renderLoading(): void {
    if (!this.root) return;
    this.root.innerHTML = `<div style="padding:20px;text-align:center;color:#6b7280;font:14px system-ui">Loading checkout…</div>`;
  }

  private renderTerminal(status: string): void {
    if (!this.root) return;
    const label = status === 'completed' ? 'Already paid'
      : status === 'expired' ? 'Session expired'
      : status === 'canceled' ? 'Session canceled'
      : 'Session unavailable';
    this.root.innerHTML = `<div style="padding:20px;text-align:center;color:#6b7280;font:14px system-ui"><strong>${esc(label)}</strong></div>`;
    if (status === 'completed') this.opts.onComplete?.({ sessionId: this.opts.sessionId });
  }

  private renderActive(): void {
    if (!this.root || !this.session) return;
    const s = this.session;
    const accent = s.branding.brandAccentColor || '#A16207';
    const amount = formatMoney(s.session.amount, s.session.currency);
    const groups: Record<string, typeof s.catalog> = {};
    for (const m of s.catalog) (groups[m.group] ??= []).push(m);

    const methodsHtml = Object.entries(groups).map(([g, rows]) => `
      <div style="margin-bottom:12px">
        <div style="font:600 11px/1.4 ui-monospace,monospace;text-transform:uppercase;color:#6b7280;margin-bottom:6px">${esc(GROUP_LABEL[g] ?? g)}</div>
        ${rows.map((m) => `
          <button type="button" data-method="${esc(m.id)}" style="display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;margin-bottom:6px;cursor:pointer;font:14px system-ui;text-align:left">
            <span>${esc(m.label)}</span>
            <span class="pp-radio" style="width:14px;height:14px;border:2px solid rgba(0,0,0,0.25);border-radius:999px"></span>
          </button>
        `).join('')}
      </div>`).join('');

    this.root.innerHTML = `
      <div style="max-width:420px;margin:0 auto;font:14px system-ui;color:#111827">
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
          <div style="padding:14px 20px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:10px">
            ${s.branding.brandLogoUrl ? `<img src="${esc(s.branding.brandLogoUrl)}" alt="" style="height:32px;width:32px;border-radius:6px;object-fit:cover;flex:none" />` : ''}
            <div style="min-width:0">
              <div style="font:600 14px/1.3 system-ui;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.branding.brandName || 'Secure payment')}</div>
              <div style="font:400 11px/1.3 system-ui;color:#6b7280">Secure payment</div>
            </div>
          </div>
          <div style="padding:16px 20px;border-bottom:1px solid #f3f4f6">
            <div style="font:600 11px/1.4 ui-monospace,monospace;text-transform:uppercase;color:#6b7280">Amount due</div>
            <div style="font:700 28px/1.1 system-ui;margin-top:4px">${esc(amount)}</div>
          </div>
          <div style="padding:16px 20px">
            ${methodsHtml}
            <button type="button" id="pp-pay" style="width:100%;padding:12px;margin-top:8px;background:${accent};color:#fff;font:600 14px system-ui;border:0;border-radius:8px;cursor:pointer">Pay now</button>
            <div id="pp-error" style="margin-top:10px;color:#dc2626;font-size:12px;display:none"></div>
          </div>
          <div style="padding:10px 20px;text-align:center;border-top:1px solid #f3f4f6;font-size:11px;color:#6b7280">
            ${esc(s.branding.brandTagline || 'Secure checkout powered by Plugipay')}
          </div>
        </div>
      </div>`;
    this.wireMethodButtons(accent);
    this.root.querySelector<HTMLButtonElement>('#pp-pay')!.onclick = () => void this.pay();
  }

  private wireMethodButtons(accent: string): void {
    if (!this.root) return;
    const paint = () => {
      this.root!.querySelectorAll<HTMLButtonElement>('[data-method]').forEach((btn) => {
        const active = btn.dataset.method === this.selected;
        btn.style.borderColor = active ? accent : '#e5e7eb';
        btn.style.background  = active ? `${accent}12` : '#fff';
        const dot = btn.querySelector<HTMLSpanElement>('.pp-radio');
        if (dot) {
          dot.style.borderColor = active ? accent : 'rgba(0,0,0,0.25)';
          dot.style.background  = active ? accent : 'transparent';
        }
      });
    };
    this.root.querySelectorAll<HTMLButtonElement>('[data-method]').forEach((btn) => {
      btn.onclick = () => {
        this.selected = btn.dataset.method ?? null;
        paint();
      };
    });
    paint();
  }

  private showError(msg: string): void {
    const el = this.root?.querySelector<HTMLDivElement>('#pp-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  // ─── Charge flow ───────────────────────────────────────────

  private async pay(): Promise<void> {
    if (!this.selected) { this.showError('Pick a payment method'); return; }
    const btn = this.root?.querySelector<HTMLButtonElement>('#pp-pay');
    if (btn) { btn.disabled = true; btn.textContent = 'Charging…'; }
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/v1/public/checkout/sessions/${this.opts.sessionId}/charge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: this.selected }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
        throw new Error(payload?.error?.message ?? `Charge failed (${res.status})`);
      }
      const body = (await res.json()) as { data: ChargeResponse };
      if (body.data.kind === 'redirect') {
        const go = this.opts.onBeforeRedirect?.({ url: body.data.redirectUrl });
        if (go !== false) window.location.href = body.data.redirectUrl;
        return;
      }
      if (body.data.kind === 'instructions') {
        this.renderManual(body.data.instructions);
        return;
      }
      throw new Error('Unexpected charge response');
    } catch (e) {
      this.showError((e as Error).message);
      if (btn) { btn.disabled = false; btn.textContent = 'Pay now'; }
    }
  }

  private renderManual(data: ManualInstructions): void {
    if (!this.root || !this.session) return;
    const accent = this.session.branding.brandAccentColor || '#A16207';
    const amount = formatMoney(data.amount, data.currency);
    const banks = (data.bankAccounts ?? []).map((b, i) => `
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:6px">
        <div style="font:600 11px/1.4 ui-monospace,monospace;text-transform:uppercase;color:#6b7280">${esc(b.bankName)}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <div style="flex:1;font:600 16px ui-monospace,monospace">${esc(b.accountNumber)}</div>
          <button type="button" data-copy="${esc(b.accountNumber)}" style="padding:4px 8px;border:1px solid #e5e7eb;border-radius:6px;font-size:11px;cursor:pointer;background:#fff">Copy</button>
        </div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px">a.n. ${esc(b.accountHolder)}</div>
      </div>`).join('');
    this.root.innerHTML = `
      <div style="max-width:420px;margin:0 auto;font:14px system-ui;color:#111827">
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px">
          <div style="background:#f3f4f6;border-radius:8px;padding:10px 12px;margin-bottom:12px">
            <div style="font:600 11px ui-monospace,monospace;text-transform:uppercase;color:#6b7280">Pay exactly</div>
            <div style="font:700 22px system-ui;margin-top:2px">${esc(amount)}</div>
          </div>
          <div style="font:600 16px system-ui;margin-bottom:4px">${esc(data.heading)}</div>
          ${data.note ? `<div style="color:#6b7280;font-size:13px;margin-bottom:12px">${esc(data.note)}</div>` : ''}
          ${banks}
          ${data.qrImageUrl ? `<div style="text-align:center;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-top:8px"><img src="${esc(data.qrImageUrl)}" alt="QRIS" style="width:200px;height:200px;object-fit:contain"/></div>` : ''}
          <div style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;font-size:12px;margin-top:12px">After you send the payment, the merchant will confirm — you&apos;ll get a notification when settled.</div>
          <button type="button" id="pp-sent" style="width:100%;padding:12px;margin-top:12px;background:${accent};color:#fff;font:600 14px system-ui;border:0;border-radius:8px;cursor:pointer">I&rsquo;ve sent the payment</button>
        </div>
      </div>`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
      btn.onclick = async () => {
        await navigator.clipboard.writeText(btn.dataset.copy ?? '');
        const old = btn.textContent; btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = old; }, 1200);
      };
    });
    this.root.querySelector<HTMLButtonElement>('#pp-sent')!.onclick = () => {
      const url = this.session!.session.successUrl;
      const go = this.opts.onBeforeRedirect?.({ url });
      if (go !== false) window.location.href = url;
      else this.opts.onComplete?.({ sessionId: this.opts.sessionId });
    };
  }

  private fail(msg: string, code?: string): void {
    if (this.root) this.root.innerHTML = `<div style="padding:20px;text-align:center;color:#dc2626;font:14px system-ui">Could not load checkout: ${esc(msg)}</div>`;
    this.opts.onError?.({ message: msg, code });
  }
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'IDR' ? 'id-ID' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: currency === 'IDR' ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}
