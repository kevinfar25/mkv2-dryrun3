# Acceptance report template (one section per ticket)

```
### <GS-id> (#<issue>) — <short title>
**Fixed in PR #<n> (or: No code change — already fixed) · Severity: <sev> · Area: <feature>**

**🔴 Before (the bug):** <one-line plain summary of the wrong behavior>
1. <repro step from the issue's Steps to Reproduce>
2. …
3. → Observed: <the issue's Actual Result>

**🟢 After (expected):** <Expected Result + acceptance criteria, in plain words>

**🧪 Test it yourself (~N min, <env>):**
- URL: <exact URL — prod heygoose.com or the preview deploy URL>
- Login: <role + resolved credentials — e.g. heygoose.com as the role-typed QA account,
  or the local dev role-switcher / dev_user_id cookie>
- <exact click path>
- (sanity) <a should-still-work check to prove nothing legit broke>

**✅ Pass = <single plain-sentence pass condition>.**

**🔬 Automated coverage:** <spec file + count> · full suite <N passed>.

**→ If it passes, move the card Open→Fixed.**
```

Rules: resolve REAL credentials/URLs (no placeholders); pass condition is ONE sentence;
always include a sanity "still-works" check; cite the real spec filename + suite count.
For UI tickets, drop the verification screenshot path next to the section.
