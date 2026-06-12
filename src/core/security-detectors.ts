/**
 * Structural secret detectors.
 *
 * These run alongside the user-configured regex patterns in
 * `config.redaction.patterns`. They look for well-known token shapes
 * (GitHub PATs, AWS access keys, JWTs, etc.) — high-precision signal
 * that should fire even when the operator hasn't added a custom pattern.
 *
 * Each detector has a stable `id` so operators can disable individual
 * detectors via `security.token_detection.detectors[id] = false` without
 * having to redefine the full list.
 */

export interface TokenDetector {
  id: string;
  label: string;
  /** Severity bias — if the user is in strict mode it becomes block, otherwise warn. */
  pattern: RegExp;
}

/**
 * Detectors are tuned for low false-positive rates. Anchors and
 * length constraints are intentional; loosening them turns noisy.
 */
export const BUILTIN_DETECTORS: TokenDetector[] = [
  // GitHub
  { id: 'github_pat',           label: 'GitHub personal access token',  pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { id: 'github_pat_v2',        label: 'GitHub fine-grained PAT',        pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { id: 'github_oauth',         label: 'GitHub OAuth token',             pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  { id: 'github_user_to_server',label: 'GitHub user-to-server token',    pattern: /\bghu_[A-Za-z0-9]{36}\b/ },
  { id: 'github_server_to_server', label: 'GitHub server-to-server token', pattern: /\bghs_[A-Za-z0-9]{36}\b/ },
  { id: 'github_refresh',       label: 'GitHub refresh token',           pattern: /\bghr_[A-Za-z0-9]{36}\b/ },

  // AWS
  { id: 'aws_access_key',       label: 'AWS access key ID',              pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'aws_temp_access_key',  label: 'AWS temporary access key ID',    pattern: /\bASIA[0-9A-Z]{16}\b/ },

  // Google
  { id: 'google_api_key',       label: 'Google API key',                 pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/ },

  // Slack
  { id: 'slack_token',          label: 'Slack token',                    pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'slack_webhook',        label: 'Slack webhook',                  pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{24,}/ },

  // Stripe
  { id: 'stripe_secret',        label: 'Stripe secret key',              pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/ },

  // Generic structural
  { id: 'jwt',                  label: 'JSON Web Token',                 pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: 'pem_private_key',      label: 'PEM-encoded private key',        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },

  // Generic high-confidence: connection strings with embedded credentials.
  { id: 'url_basic_auth',       label: 'URL with embedded credentials',  pattern: /[a-z][a-z+.-]+:\/\/[^\s:@/]+:[^\s@/]{4,}@[A-Za-z0-9.-]+/ },
];

export interface DetectorMatch {
  detectorId: string;
  label: string;
  /** The substring that matched, truncated for safe display. */
  excerpt: string;
}

/**
 * Run every enabled structural detector across `text`. Detectors with an
 * explicit `false` in `disabled` are skipped.
 */
export function runStructuralDetectors(text: string, disabled?: Record<string, boolean>): DetectorMatch[] {
  const out: DetectorMatch[] = [];
  for (const d of BUILTIN_DETECTORS) {
    if (disabled && disabled[d.id] === false) continue;
    const m = text.match(d.pattern);
    if (m) {
      out.push({
        detectorId: d.id,
        label: d.label,
        excerpt: truncate(m[0]),
      });
    }
  }
  return out;
}

/**
 * Shannon entropy in bits per character. Higher = more random.
 *  - English prose       ~2.5–3.0
 *  - hex-encoded data    ~3.5–4.0
 *  - base64-encoded data ~5.0–6.0
 *  - cryptographic keys  ~5.5+
 */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface EntropyMatch {
  excerpt: string;
  entropy: number;
}

const SECRET_KEYWORD_CONTEXT = /(?:api[_-]?key|secret|token|password|passwd|auth|bearer|access[_-]?key|private[_-]?key)/i;
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9_+/=\-]{16,}/g;

/**
 * Entropy-based detection. Scans `text` for token-shaped substrings near
 * a sensitive keyword. Two-stage gating keeps false positives low:
 *   1. The substring is at least `minLength` chars of token-character class.
 *   2. Shannon entropy ≥ `minEntropy` bits/char.
 *   3. Either the substring or the surrounding text contains a secret
 *      keyword (api_key, token, secret, etc.).
 */
export function runEntropyDetector(
  text: string,
  options: { enabled?: boolean; minLength?: number; minEntropy?: number } = {},
): EntropyMatch[] {
  if (options.enabled === false) return [];
  const minLength = options.minLength ?? 32;
  const minEntropy = options.minEntropy ?? 4.0;

  const out: EntropyMatch[] = [];
  HIGH_ENTROPY_CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HIGH_ENTROPY_CANDIDATE.exec(text)) !== null) {
    const token = m[0];
    if (token.length < minLength) continue;
    const entropy = shannonEntropy(token);
    if (entropy < minEntropy) continue;

    // Avoid flagging plain decimal numbers (very low entropy but pass length).
    if (/^[0-9]+$/.test(token)) continue;

    // Context check: keyword either in the candidate itself or in the surrounding 80 chars.
    const start = Math.max(0, m.index - 40);
    const end = Math.min(text.length, m.index + token.length + 40);
    const context = text.slice(start, end);
    if (!SECRET_KEYWORD_CONTEXT.test(context)) continue;

    out.push({ excerpt: truncate(token), entropy: Math.round(entropy * 100) / 100 });
  }
  return out;
}

function truncate(s: string, maxLen = 48): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(8, maxLen / 2)) + '…' + s.slice(-Math.max(4, maxLen / 4));
}
