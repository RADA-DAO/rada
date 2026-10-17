import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { NotificationWorker } from "./worker.ts";
const url = process.env.NOTIFICATIONS_TEST_DATABASE_URL;
await test(
  "database workers serialize, retry, recheck consent and recover uncertain attempts",
  { skip: !url },
  async () => {
    const admin = new pg.Pool({ connectionString: url });
    const service = new pg.Pool({
      connectionString: url,
      options: "-c role=notifications_service",
    });
    let sends = 0;
    try {
      const s = (
        await admin.query<{ subject: string }>(
          "SELECT identity.resolve_telegram(90502) AS subject",
        )
      ).rows[0]!.subject;
      await admin.query("SELECT set_config('rada.subject_id',$1,false)", [s]);
      await admin.query(
        "SELECT notifications.set_preference('splash',true,'en',NULL,NULL)",
      );
      await admin.query(
        "SELECT notifications.enqueue('race:1','won','splash',$1,now()+interval '1 day')",
        [s],
      );
      let release: () => void = () => {};
      let started: () => void = () => {};
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const send = (async () => {
        sends++;
        started();
        await barrier;
        return new Response('{"ok":true}');
      }) as typeof fetch;
      const config = { enabled: true, token: "fixture", allowed: ["90502"] };
      const first = new NotificationWorker(service, config, send);
      const second = new NotificationWorker(service, config, send);
      const run = first.run();
      await startedPromise;
      await Promise.all([second.run(), first.run()]);
      assert.equal(sends, 1);
      release();
      await run;
      await second.run();
      assert.equal(sends, 1);
      await admin.query(
        "SELECT notifications.enqueue('retry:1','won','splash',$1,now()+interval '1 day')",
        [s],
      );
      await new NotificationWorker(service, config, () =>
        Promise.resolve(new Response('{"ok":false}', { status: 500 })),
      ).run();
      const pending = (
        await admin.query(
          "SELECT status,attempts FROM notifications.events WHERE event_key='retry:1'",
        )
      ).rows[0];
      assert.equal(pending.status, "pending");
      assert.equal(pending.attempts, 1);
      await admin.query(
        "UPDATE notifications.events SET next_at=now()-interval '1 second' WHERE event_key='retry:1'",
      );
      await second.run();
      assert.equal(sends, 2);
      await admin.query(
        "SELECT notifications.enqueue('uncertain:1','won','splash',$1,now()+interval '1 day')",
        [s],
      );
      await admin.query("SELECT notifications.reserve(NULL)");
      await second.run();
      assert.equal(sends, 2);
      assert.equal(
        (
          await admin.query(
            "SELECT status FROM notifications.events WHERE event_key='uncertain:1'",
          )
        ).rows[0].status,
        "uncertain",
      );
      await admin.query(
        "SELECT notifications.enqueue('revoke:1','won','splash',$1,now()+interval '1 day')",
        [s],
      );
      await admin.query(
        "SELECT notifications.set_preference('splash',false,'en',NULL,NULL)",
      );
      await second.run();
      assert.equal(sends, 2);
    } finally {
      await admin.query(
        "DELETE FROM notifications.attempts WHERE event_id IN (SELECT id FROM notifications.events WHERE subject_id=(SELECT subject_id FROM identity.telegram_accounts WHERE telegram_user_id=90502)); DELETE FROM notifications.events WHERE subject_id=(SELECT subject_id FROM identity.telegram_accounts WHERE telegram_user_id=90502); DELETE FROM notifications.preferences WHERE subject_id=(SELECT subject_id FROM identity.telegram_accounts WHERE telegram_user_id=90502); DELETE FROM notifications.consent_history WHERE subject_id=(SELECT subject_id FROM identity.telegram_accounts WHERE telegram_user_id=90502)",
      );
      await service.end();
      await admin.end();
    }
  },
);
