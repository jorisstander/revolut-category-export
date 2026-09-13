---
name: Export is broken or wrong
about: The popup fails, or the CSV is missing or misreporting transactions
labels: bug
---

**What happened**

<!-- What you clicked, and what the popup showed. Quote any message verbatim. -->

**Spike output**

<!-- The most useful thing you can include. On a logged-in app.revolut.com tab, open
     DevTools (F12) -> Console, paste the contents of spike/snippet.js, and put the
     output here. It says what the API is doing now, which separates a change on
     Revolut's side from a bug in this code.

     What it prints: account types, currencies, pocket types, HTTP status codes, row
     counts, category names, and SHORTENED account and wallet ids (first eight
     characters). It prints no amounts, no merchant names and no card or IBAN numbers.

     One thing it cannot control: if a request fails at the network level, Chrome prints
     its own red error line, and that line contains the full request URL including a
     full-length account id. Delete any red line before posting, or replace the id in it.

     Those shortened ids are not secrets, but they are yours. Replace them with A, B, C
     if you would rather not post them -- the output is just as useful. -->

```
```

**Browser and version**

<!-- e.g. Chrome 131. The popup needs Chrome 105 or newer. -->

**If the CSV is wrong rather than missing**

<!-- How many rows you expected and how many you got. Please do NOT paste the file:
     it is your bank statement. Row counts and totals are enough. -->
