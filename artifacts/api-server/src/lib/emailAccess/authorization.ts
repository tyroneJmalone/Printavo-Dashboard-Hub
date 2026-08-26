import { pool, type StaffUser } from "@workspace/db";

/**
 * Content access never follows role rank. Admins can configure access but
 * cannot read a protected mailbox unless they own it, receive it through an
 * access group, or are granted one conversation by Missive.
 */
export async function authorizedMailboxIds(staff: StaffUser): Promise<string[]> {
  const result = await pool.query<{ mailbox_id: string }>(
    `
      SELECT DISTINCT p.mailbox_id
      FROM email_mailbox_policies p
      WHERE p.owner_staff_id = $1::uuid
         OR (p.protected = false AND p.visibility = 'workspace')
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
    [staff.id],
  );
  return result.rows.map((row) => row.mailbox_id);
}

export async function canReadMailbox(staff: StaffUser, mailboxId: string): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT 1
      FROM email_mailbox_policies p
      WHERE p.mailbox_id = $2::uuid
        AND (
          p.owner_staff_id = $1::uuid
          OR (p.protected = false AND p.visibility = 'workspace')
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
    [staff.id, mailboxId],
  );
  return result.rowCount === 1;
}

export async function canReadThread(staff: StaffUser, threadId: string): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT 1
      FROM correspondence_threads t
      LEFT JOIN email_mailbox_policies p ON p.mailbox_id = t.mailbox_id
      WHERE t.id = $2::uuid
        AND (
          p.owner_staff_id = $1::uuid
          OR (p.protected = false AND p.visibility = 'workspace')
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
    [staff.id, threadId],
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