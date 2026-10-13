# OnePick website

The OnePick website, connected to your Supabase database (sign-up, picks, leagues, tables).

## Put it online (about 15 minutes, free)

1. Create a **private** repository on github.com (call it `onepick-web`) and upload everything in this folder
   (drag the files into the repo page; don't upload a `node_modules` folder if you have one).
2. Go to vercel.com, sign up with your GitHub account, click **Add New → Project**, and choose `onepick-web`.
   Vercel detects the settings itself (Vite). Click **Deploy**.
3. After a minute or two you get a web address ending in `.vercel.app`. That is your site.

To update the site later, replace the changed files in the GitHub repo. Vercel redeploys on its own.

## Keys

The Supabase project URL and the **anon (public)** key are already in `src/api.js` as defaults. They are designed to be
visible in a website. The database rules keep people out of data they shouldn't see.

- **Never** put the `service_role` key in this project.
- If you reset your Supabase keys, add the new project URL and anon key in Vercel under
  Settings → Environment Variables as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then redeploy.

## Run it on your own computer (optional)

```
npm install
npm run dev
```
