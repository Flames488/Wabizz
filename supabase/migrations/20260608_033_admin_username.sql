-- Fix admin username: rename "Emmanuel Nwobodo" → "Emmanuel" to match login screen.
-- If the wrong username was seeded, this corrects it.
-- Safe to run multiple times (noop if already correct or no row exists).
UPDATE public.admin_users
SET username = 'Emmanuel'
WHERE username = 'Emmanuel Nwobodo';
