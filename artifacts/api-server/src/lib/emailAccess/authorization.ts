import { pool, type StaffUser } from "@workspace/db";

export async function authorizedMailboxIds(staff: StaffUser): Promise<string[]> {
  if (staff.role === "admin") {
    const all = await pool.query<{ mailbox_id: string }>(
      "SELECT id AS mailbox_id FROM email_mailboxes",
    );
    return all.rows.map((row) => row.mailbox_id);
  }
  const result = await pool.query<{ mailbox_id: string }>(
    `
      SELECT DISTINCT p.mailbox_id
      FROM email_mailbox_policies p
      WHERE p.owner_staff_id = $1::uuid
         OR ($2::text = 'staff' AND p.protected = false AND p.visibility = 'workspace')
         OR (
           p.visibility IN ('group', 'workspace')
           AND EXISTS (
             SELECT 1
             FROM email_access_group_mailboxes gm
             JOIN email_access_group_members gu ON gu.group_id = gm.group_id
             WHERE gm.mailbox_id = p.mailbox_id
               AND gu.staff_id = $1::uuid
           )
         )
    `,
    [staff.id, staff.role],
  );
  return result.rows.map((row) => row.mailbox_id);
}

export async function canReadMailbox(staff: StaffUser, mailboxId: string): Promise<boolean> {
  if (staff.role === "admin") {
    const mailbox = await pool.query(
      "SELECT 1 FROM email_mailboxes WHERE id=$1::uuid LIMIT 1",
      [mailboxId],
    );
    return mailbox.rowCount === 1;
  }
  const result = await pool.query(
    `
      SELECT 1
      FROM email_mailbox_policies p
      WHERE p.mailbox_id = $2::uuid
        AND (
          p.owner_staff_id = $1::uuid
           OR ($3::text = 'staff' AND p.protected = false AND p.visibility = 'workspace')
          OR (
            p.visibility IN ('group', 'workspace')
            AND EXISTS (
              SELECT 1
              FROM email_access_group_mailboxes gm
              JOIN email_access_group_members gu ON gu.group_id = gm.group_id
              WHERE gm.mailbox_id = p.mailbox_id
                AND gu.staff_id = $1::uuid
            )
          )
        )
      LIMIT 1
    `,
    [staff.id, mailboxId, staff.role],
  );
  return result.rowCount === 1;
}

export async function canReadThread(staff: StaffUser, threadId: string): Promise<boolean> {
  if (staff.role === "admin") {
    const thread = await pool.query(
      "SELECT 1 FROM correspondence_threads WHERE id=$1::uuid LIMIT 1",
      [threadId],
    );
    return thread.rowCount === 1;
  }
  const result = await pool.query(
    `
      SELECT 1
      FROM correspondence_threads t
      LEFT JOIN email_mailbox_policies p ON p.mailbox_id = t.mailbox_id
      WHERE t.id = $2::uuid
        AND (
          p.owner_staff_id = $1::uuid
           OR ($3::text = 'staff' AND p.protected = false AND p.visibility = 'workspace')
          OR (
            p.visibility IN ('group', 'workspace')
            AND EXISTS (
              SELECT 1
              FROM email_access_group_mailboxes gm
              JOIN email_access_group_members gu ON gu.group_id = gm.group_id
              WHERE gm.mailbox_id = t.mailbox_id
                AND gu.staff_id = $1::uuid
            )
          )
          OR EXISTS (
            SELECT 1
            FROM correspondence_thread_grants tg
            WHERE tg.thread_id = t.id
              AND tg.staff_id = $1::uuid
              AND tg.active = true
              AND tg.revoked_at IS NULL
              AND (tg.expires_at IS NULL OR tg.expires_at > now())
              AND 'read' = ANY(tg.capabilities)
          )
        )
      LIMIT 1
    `,
    [staff.id, threadId, staff.role],
  );
  return result.rowCount === 1;
}

export async function requireMailboxRead(
  staff: StaffUser,
  mailboxId: string,
): Promise<void> {
  if (!(await canReadMailbox(staff, mailboxId))) {
    const error = new Error("Not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }
}

export async function requireThreadRead(staff: StaffUser, threadId: string): Promise<void> {
  if (!(await canReadThread(staff, threadId))) {
    const error = new Error("Not found") as Error & { status?: number };
    error.status = 404;
    throw error;
  }
}