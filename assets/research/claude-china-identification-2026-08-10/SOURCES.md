# Sources and evidence ledger

Accessed 2026-08-10. Sources are ordered roughly from strongest primary evidence to contextual reporting.

## Primary and first-party sources

1. [Thereallo, “Claude Code Is Steganographically Marking Requests”](https://thereallo.dev/blog/claude-code-prompt-steganography) — Original technical write-up with cleaned code, trigger conditions, character mapping, decoded keyword examples, and a signed-binary hash. Strongest public technical source; still an independent reverse-engineer's report rather than an Anthropic audit.
2. [Thariq Shihipar's X reply](https://x.com/trq212/status/2072079729331777817) — Claude Code engineer acknowledges the March experiment, states its anti-reseller/anti-distillation purpose, and announces rollback.
3. [Anthropic Privacy Center, “Does Claude use my location?”](https://privacy.claude.com/en/articles/11186740-does-claude-use-my-location) — Official disclosure that IP and other signals are used for country/region inference for security and anti-abuse; dated 2026-03-16.
4. [Anthropic, supported countries and regions](https://www.anthropic.com/supported-countries) — Current availability policy. Mainland China is not listed among supported Claude.ai regions as of collection.
5. [Anthropic, “Updating restrictions of sales to unsupported regions”](https://www.anthropic.com/news/updating-restrictions-of-sales-to-unsupported-regions) — Explains the policy applying restrictions to China-controlled entities even when operating through subsidiaries elsewhere.
6. [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) — Confirms release numbering. The 2.1.197 entry did not document the marker removal, so it cannot by itself prove the rollback.

## Original amplification and independent corroboration

7. [International Cyber Digest X post](https://x.com/IntCyberDigest/status/2071971609183678544) — The viral post that drove the X discussion. Useful as a record of the claim, but its “every user” wording is broader than the analyzed code supports.
8. [International Cyber Digest article](https://www.internationalcyberdigest.com/claude-code-accused-of-hiding-china-proxy-fingerprints-inside-system-prompts/) — Links the original Reddit discussion and a GitHub-hosted verification, and later adds the engineer's response.
9. [Corey Quinn's X post](https://x.com/QuinnyPig/status/2072097751899525464) — Claims independent verification in 2.1.91 and an early/current 2.1.197 package. Useful corroboration, with a version-timing caveat.
10. [Hacker News discussion](https://news.ycombinator.com/item?id=48734373) — Large technical discussion of the primary report. Useful for critiques and alternate interpretations, not authoritative by itself.

## Later reporting and affected-version scope

11. [Reuters report republished by Investing.com](https://www.investing.com/news/stock-market-news/china-issues-backdoor-security-alert-over-anthropics-claude-code-4781929) — Reports China's National Vulnerability Database warning and its affected range of 2.1.91–2.1.196, plus advice to upgrade.
12. [The Register, “Anthropic is removing its covert code for catching Chinese competitors”](https://www.theregister.com/ai-and-ml/2026/07/01/anthropic-is-removing-its-covert-code-for-catching-chinese-competitors/5265366) — Contemporary reporting on the rollback promise.
13. [Tom's Hardware report](https://www.tomshardware.com/tech-industry/artificial-intelligence/alibaba-bans-anthropics-claude-code-after-an-alleged-hidden-china-detection-backdoor-is-uncovered-employees-told-to-switch-to-qoder-as-the-rift-between-the-firms-widens) — Later summary of the technical claims, Anthropic staff response, and organizational reaction.

## Source-quality cautions

- X posts are public statements, not automatically evidence. Only the engineer response and posts offering claimed independent reproduction materially improve confidence.
- The reverse-engineered client is proprietary/minified, so cleaned variable names in the report are explanatory renamings.
- “Backdoor,” “spyware,” and “tracking” are contested labels. The observable fact is a covert client-generated classification marker in outbound system context.
- Later reporting consistently says the feature was removed, but Anthropic's public changelog did not explicitly record the removal. The exact build boundary around the first 2.1.197 package is therefore not fully resolved by public first-party documentation.
