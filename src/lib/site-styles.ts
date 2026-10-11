/* Phantom's stylesheet, for every page.

   Imported by the root layout, so every route has it - the root error page
   included. It was once kept off the root so a separate review desk could
   carry its own sheet, with the error page linking a copy by URL; the desk is
   gone (review is on Ari), and that link pointed at a file the client build
   named differently, so 404s rendered unstyled. The Phantom entry points that
   still import it too (the shell, onboarding, the landing page, the pfp tool)
   are harmless: it is one module, loaded once.

   Fonts first - they define the --font-* variables in :root - then globals,
   which reference them. Import it before anything else in the file so the
   sheet still comes first in the cascade. */
import '../fonts.css';
import '../globals.css';
