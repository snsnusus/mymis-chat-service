// Room ids for 1:1 conversations. A room id is the two participants' user ids,
// smaller first, joined with "-" (e.g. users 3 and 1 → "1-3"). There is exactly one
// valid id per pair of users, so a conversation can never be split across two ids.

// Builds the room id for two users. Throws on invalid input: the server validates the
// recipient before calling this, so a throw here means a bug, not bad user input.
export function roomIdFor(userA: string, userB: string): string {
  if (userA === "" || userB === "") {
    throw new Error("User ids must not be empty");
  }
  if (userA.includes("-") || userB.includes("-")) {
    throw new Error('User ids must not contain "-"'); // it would make the room id ambiguous
  }
  if (userA === userB) {
    throw new Error("A room needs two different users");
  }

  // Plain < compares by character code: the same result on every machine, unlike
  // localeCompare. "10" < "9" is true (character by character), which is fine: what matters
  // is that the order is always the same, not that it looks numeric.
  return userA < userB ? `${userA}-${userB}` : `${userB}-${userA}`;
}

// Checks that a string is a valid room id and returns its two participants.
// Returns null for ANYTHING else, never throws: room ids arrive from URLs (untrusted input).
export function parseRoomId(roomId: string): [string, string] | null {
  const parts = roomId.split("-");

  // Exactly one "-" means exactly two parts. ("1" → 1 part, "1-2-3" → 3 parts.)
  if (parts.length !== 2) {
    return null;
  }

  const [userA, userB] = parts;

  // TypeScript still types these as string | undefined (noUncheckedIndexedAccess), so check
  // them. The same check rejects empty sides: "-3" splits into ["", "3"].
  if (
    userA === undefined ||
    userB === undefined ||
    userA === "" ||
    userB === ""
  ) {
    return null;
  }

  // Same user twice ("1-1") is never a valid room. Checked here, before roomIdFor,
  // because roomIdFor would THROW for it, and this function must never throw.
  if (userA === userB) {
    return null;
  }

  // Canonical check: rebuild the id the official way and compare. Wrong order ("3-1")
  // rebuilds as "1-3", so it doesn't match and is rejected rather than silently fixed.
  if (roomIdFor(userA, userB) !== roomId) {
    return null;
  }

  return [userA, userB];
}

// Whether a user is one of the room's two participants.
// Built on parseRoomId, so malformed or non-canonical ids are never treated as real rooms.
export function isRoomMember(roomId: string, userId: string): boolean {
  const participants = parseRoomId(roomId);
  if (participants === null) {
    return false;
  }
  return participants.includes(userId);
}
