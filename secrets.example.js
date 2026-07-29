/* secrets.example.js — copy to secrets.js and fill in.
 *
 * secrets.js is gitignored. It never reaches the public repository.
 * The Android build copies it into the APK, so the phone needs no setup.
 * The public web build ships without it and asks once, storing the answer locally.
 *
 * Set a credit limit on the key at https://openrouter.ai/settings/keys — an APK
 * is not a vault, and anyone with the file can read the string out of it.
 */
export const OPENROUTER_KEY = 'sk-or-v1-REPLACE_ME';

/* Free and fast. Swap for a bigger model if the reasoning feels thin. */
export const OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
