

/**
 * Core MV3 Extension client supporting pairing code exchange, current tab capture,
 * selected text capture, and context menu link capture with explicit error states.
 */
export class ExtensionCaptureClient {

  constructor(initialInstanceUrl = 'http://localhost:3000', transport) {
    this.storage = {
      instanceUrl: initialInstanceUrl.replace(/\/$/, ''),
      accessToken: null,
    };
    this.transport =
      transport ||
      (async (url, init) => {
        const res = await fetch(url, init);
        const data = (await res.json());
        return { status: res.status, body: data };
      });
  }

  setInstanceUrl(url) {
    this.storage.instanceUrl = url.replace(/\/$/, '');
  }

  getStorageState() {
    return { ...this.storage };
  }

  async pairWithCode(pairingCode) {
    try {
      const res = await this.transport(`${this.storage.instanceUrl}/api/extension/pair/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode }),
      });
      if (res.status === 200 && typeof res.body.accessToken === 'string') {
        this.storage.accessToken = res.body.accessToken;
        return {
          ok: true,
          state: 'paired',
          message: 'Paired with self-hosted instance.',
        };
      }
      return {
        ok: false,
        state: 'unauthenticated',
        message: 'Pairing code is invalid or expired. Generate a new code in Settings.',
      };
    } catch {
      return {
        ok: false,
        state: 'unreachable',
        message: `Instance at ${this.storage.instanceUrl} is unreachable.`,
      };
    }
  }

  async capture(input
  ) {
    if (!this.storage.accessToken) {
      return {
        ok: false,
        state: 'unauthenticated',
        message: 'Extension is not paired. Enter a pairing code from Settings.',
      };
    }

    try {
      const res = await this.transport(`${this.storage.instanceUrl}/api/items/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.storage.accessToken}`,
        },
        body: JSON.stringify(input),
      });

      if (res.status === 200 || res.status === 201) {
        const item = res.body.item;
        return {
          ok: true,
          state: 'saved',
          message: 'Saved to your library.',
          itemId: item?.id,
        };
      }

      if (res.status === 401) {
        return {
          ok: false,
          state: 'revoked_token',
          message: 'Extension token was revoked or expired. Please re-pair in Settings.',
        };
      }

      return {
        ok: false,
        state: 'invalid_request',
        message: String(res.body.error || 'Could not capture URL.'),
      };
    } catch {
      return {
        ok: false,
        state: 'unreachable',
        message: `Cannot reach instance at ${this.storage.instanceUrl}. Check your connection or instance URL.`,
      };
    }
  }
}
