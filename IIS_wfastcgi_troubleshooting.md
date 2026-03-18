# IIS + wfastcgi HTTP 500 troubleshooting notes (CDAT_Goaling)

Date: 2026-03-16

## Symptom
- Browsing `http://cdatdelivery.amr.corp.intel.com/CDAT_Goaling` returned **HTTP 500**.
- App-local log `C:\inetpub\wwwroot\cdatdelivery\CDAT_Goaling\logs\wfastcgi.log` was empty.

## Root cause
The installed `wfastcgi.py` on this server expects the environment variable **`WSGI_HANDLER`**.

When it isn’t present, wfastcgi fails during startup with an error like:

> Exception: WSGI_HANDLER env var must be set

This is why IIS returned HTTP 500 without running the Flask app.

## Key IIS findings
### App handler mapping (effective at application level)
The IIS application `cdatdelivery/CDAT_Goaling` correctly routes requests through FastCGI:
- Handler uses `modules="FastCgiModule"`
- `scriptProcessor="C:\python311\python.exe|C:\python311\Lib\site-packages\wfastcgi.py"`

You can re-check with:
- `appcmd list config "cdatdelivery/CDAT_Goaling" /section:system.webServer/handlers`

### Server-level FastCGI registration (the important part)
Server-level FastCGI env vars were initially incorrect:
- Used `WSGI_HANDLER` incorrectly/was missing after edits
- `PYTHONPATH` pointed at the wrong folder (`C:\inetpub\apps\CDAT_Goaling`)
- `WSGI_LOG` pointed at a different log path (`C:\inetpub\apps\CDAT_Goaling\wfastcgi.log`)

Because FastCGI registrations are typically configured **server-wide**, these values can control what wfastcgi sees.

You can re-check with:
- `appcmd list config /section:fastCgi`

## What fixed it
Update the server-level FastCGI env vars for:
- `fullPath="C:\python311\python.exe"`
- `arguments="C:\python311\Lib\site-packages\wfastcgi.py"`

Final working values:
- `WSGI_HANDLER = app.app`
- `PYTHONPATH = C:\inetpub\wwwroot\cdatdelivery\CDAT_Goaling`
- `WSGI_LOG = C:\inetpub\wwwroot\cdatdelivery\CDAT_Goaling\logs\wfastcgi.log`
- `URL_PREFIX = /CDAT_Goaling` (optional, if hosted under that path)

Then recycle app pool:
- `appcmd recycle apppool /apppool.name:"CDAT_Goaling"`

## Notes / gotchas
- Some wfastcgi documentation mentions `WSGI_APP`, but **this server’s wfastcgi build expects `WSGI_HANDLER`** (confirmed by stack trace).
- If `wfastcgi.log` is empty again, confirm the IIS AppPool identity has Modify permission on `...\logs`.
- PowerShell: to run two commands, use a newline or `;` (don’t attach a second command immediately after `...handlers& ...`).

## Quick checklist for future 500s
1. Check `appcmd list config /section:fastCgi` for `WSGI_HANDLER`, `PYTHONPATH`, `WSGI_LOG`.
2. Ensure the IIS app has handler mapping to `FastCgiModule` + correct `scriptProcessor`.
3. Recycle the app pool after changes.
4. Read `...\logs\wfastcgi.log` for the traceback.
