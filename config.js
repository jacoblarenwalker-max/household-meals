// Public client config. The publishable key is safe to ship in a browser:
// all data access is enforced by Row Level Security in Supabase.
// Never put a service_role / secret key here.
export const SUPABASE_URL = 'https://voydoxmxdnjnewxlwzse.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FO-tgfKuBTb19W8GaX1qZw_dtZRRdqY';
export const HOUSEHOLD_TZ = 'America/Denver';
// Web Push (VAPID) public key. Public by design; the matching private key stays in Supabase Vault.
export const VAPID_PUBLIC_KEY = 'BCBDkqgI2arGxiD_XmKx6RgHDKZ9ZvmM8_s3G8pDi7zFjaHLaSDPp9fVJFdOn_4cvuGJVJ2WPd32eSUha7QIoEs';
