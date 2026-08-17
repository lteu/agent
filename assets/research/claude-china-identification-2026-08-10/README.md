# How Claude identified China-linked Claude Code use

Collected and reviewed: 2026-08-10 (Asia/Taipei)

## Short answer

Two separate mechanisms are being conflated online:

1. **Anthropic's general platform controls.** Anthropic officially says it uses IP addresses and unspecified "other signals" to infer a user's country or region for terms enforcement and abuse prevention. This applies broadly to consumer Claude products, including consumer accounts used with Claude Code.
2. **A now-removed Claude Code client mechanism.** A reverse-engineering report found that affected Claude Code builds classified certain **custom API routes** using the machine's timezone and the hostname in `ANTHROPIC_BASE_URL`. The result was encoded into tiny formatting differences in the system prompt sent upstream.

The second mechanism is the one that went viral on X. It was real enough that a Claude Code engineer publicly described it as an anti-reseller/anti-distillation experiment and said it would be rolled back. The viral formulation that it fingerprinted "every user" is misleading: the analyzed function returned early when `ANTHROPIC_BASE_URL` was absent or pointed to `api.anthropic.com`.

## What the Claude Code mechanism checked

| Signal | What the analyzed code reportedly did | Confidence |
|---|---|---|
| Custom route | Activated classification when `ANTHROPIC_BASE_URL` was set to a non-default endpoint | High: code shown by the reverse engineer |
| System timezone | Tested for `Asia/Shanghai` or `Asia/Urumqi` | High: code shown |
| Route hostname | Compared the custom endpoint's hostname with an obfuscated list of known domains | High: code and decoded examples shown |
| AI-lab keywords | Looked for strings such as `deepseek`, `moonshot`, `minimax`, `zhipu`, and related names in the hostname | High: decoded list shown |
| IP geolocation | Anthropic says it uses IP and other signals for country/region inference | High for the general platform; not part of the client code demonstrated in this incident |
| Payment, phone, ID, language, locale, device fingerprint | Frequently suggested online as possible account-risk signals | Unverified for this specific mechanism; no public evidence collected here establishes their role |

## How the result was transmitted

The analyzed client changed a normal-looking line in the system context:

- A China-timezone match changed a date such as `2026-06-30` to `2026/06/30`.
- Route classifications selected among look-alike apostrophe characters in the word `Today's`.
- The marker therefore travelled inside the system prompt rather than in an obvious telemetry field.

The route lists were base64-encoded and XOR-obfuscated in the distributed bundle. The reverse engineer described this as prompt steganography. "Covert marker" is a precise description; "spyware" is a value-laden label used by several X posters, not an established technical classification.

## Scope and limitations

- The demonstrated logic classified **China-linked custom routing**, not citizenship or ethnicity.
- A timezone match alone could include legitimate users outside mainland China or travelers, and it is trivial to change. It is a weak location signal, not proof of physical presence.
- `Asia/Hong_Kong` was not one of the two timezone values shown in the analyzed code.
- The hostname checks could identify a known reseller, gateway, corporate domain, or lab-associated name. They did not prove that the person operating Claude Code belonged to that company.
- The analysis showed the marker entering the system context. It did not independently demonstrate the exact server-side parsing, retention, enforcement decision, or whether a marker by itself caused an account ban.
- No evidence in the analyzed mechanism showed Claude Code uploading repository contents specifically to determine whether a user was in China.

## Timeline

- **March 2026:** According to Claude Code engineer Thariq Shihipar, Anthropic launched the mechanism as an experiment against unauthorized resellers and model distillation.
- **2026-04-02:** Later reporting and China's vulnerability advisory place the first affected public release at Claude Code 2.1.91.
- **2026-06-30:** The technical analysis and the viral International Cyber Digest X post were published.
- **2026-06-30:** Shihipar acknowledged the experiment on X and said a rollback had been merged for the following day's release.
- **2026-07-01:** Version 2.1.197 was released. Its public changelog did not mention the removal. Early X posts disagreed about whether the first build carrying that version still contained the code.
- **2026-07-08:** A Reuters report on China's National Vulnerability Database described versions 2.1.91 through 2.1.196 as affected and advised upgrading to a release where the code had been removed.

## Bottom line

The strongest defensible conclusion is:

> Affected Claude Code clients used a non-default API endpoint, the endpoint hostname, and two China-associated system timezones to label China-linked custom routes. They encoded those labels into punctuation/date formatting in the system prompt. Anthropic acknowledged the feature's anti-abuse purpose and rolled it back after disclosure. Separately, Anthropic openly uses IP address and unspecified other signals for general country/region enforcement.

What remains unknown publicly is more important than some X threads admit: the complete set of server-side "other signals," how signals were weighted, retention details, false-positive rates, and the precise enforcement workflow.

See [X-POSTS.md](./X-POSTS.md) for the social-media trail and [SOURCES.md](./SOURCES.md) for the evidence ledger.
