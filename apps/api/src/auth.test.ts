import { verifyTelegramInitData } from "./auth.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
const now = 2_000_000_000;
Deno.test(
  "valid signature, optional signature, tampering and wrong bot",
  async () => {
    const raw = await signed({
      auth_date: String(now),
      signature: "synthetic-signature",
    });
    assert(
      (await verifyTelegramInitData(raw, FIXTURE_TOKEN, "ordinary", now)) ===
        "101",
    );
    assert(
      (await verifyTelegramInitData(
        raw + "&extra=tampered",
        FIXTURE_TOKEN,
        "ordinary",
        now,
      )) === null,
    );
    assert(
      (await verifyTelegramInitData(
        raw,
        "other-synthetic-bot",
        "ordinary",
        now,
      )) === null,
    );
    assert(
      (await verifyTelegramInitData(
        raw.replace("synthetic-signature", "altered"),
        FIXTURE_TOKEN,
        "ordinary",
        now,
      )) === null,
    );
  },
);
Deno.test(
  "ordinary 24h and privileged 1h boundaries and future window",
  async () => {
    for (const [kind, ttl] of [
      ["ordinary", 86400],
      ["privileged", 3600],
    ] as const) {
      for (const [age, accepted] of [
        [ttl, true],
        [ttl + 1, false],
        [-120, true],
        [-121, false],
      ] as const) {
        const raw = await signed({ auth_date: String(now - age) });
        assert(
          ((await verifyTelegramInitData(raw, FIXTURE_TOKEN, kind, now)) !==
            null) ===
            accepted,
        );
      }
    }
  },
);
Deno.test(
  "reject malformed hashes, duplicate keys, dates, users and oversized input",
  async () => {
    const valid = await signed({ auth_date: String(now) });
    const invalid = [
      valid + "&user=%7B%22id%22%3A102%7D",
      valid + "&hash=00",
      "",
      "x".repeat(12001),
      valid.replace(/hash=[^&]+/, "hash=bad"),
    ];
    for (const date of [
      "1e9",
      " 2000000000",
      "2000000000.0",
      "",
      "9007199254740992",
    ])
      invalid.push(await signed({ auth_date: date }));
    for (const user of [
      "null",
      "{}",
      "{",
      '{"id":-1}',
      '{"id":"101"}',
      '{"id":9007199254740992}',
    ])
      invalid.push(await signed({ auth_date: String(now), user }));
    for (const raw of invalid)
      assert(
        (await verifyTelegramInitData(raw, FIXTURE_TOKEN, "ordinary", now)) ===
          null,
      );
  },
);
