# Fare Log: flight price tracker

A small website that runs on your own computer. Type a route like `TOKYO > SEOUL`, see the
cheapest dates, pick a flight, and see what every site charges for it **including bags**.
Every flight you open is saved, and its price is updated each time you search that date again
(or press Check now), so you can watch it over time. Nothing runs in the background.
It also shows rough hotel prices (3-star and up, no hostels) and how the trip compares to your budget.

## Start it

**Mac:** double-click `start.command`. The first time, macOS may say it can't verify the file:
right-click it, choose Open, then Open again.
**Windows:** double-click `start.bat`.
**Or from a terminal:** `python3 app.py`

Your browser opens at http://localhost:8765. Keep the small terminal window
open while you use the app. Close it to stop the app.

Needs Python 3.9 or newer (already on most Macs; on Windows get it from python.org).
Nothing else to install.

## Where prices come from

**Flights: free, no sign-up.** The app reads prices straight from Google Flights, the
same way the open-source `fast-flights` library does, so there's no key and no monthly
limit. If Google changes its page, free
lookups stop working until the app is updated; with a SerpApi key the flight list falls
back to SerpApi.

**Optional: a free SerpApi key** adds what Google's page alone doesn't give:
- what each site (airline, Expedia, Trip.com, Booking.com…) charges for a flight
- exact prices for each return flight on a round trip
- real hotel prices (without a key they're examples)
- a faster cheapest-dates calendar

To add one: sign up free at https://serpapi.com (about 250 searches a month), copy your
key from the dashboard, and paste it in the app's **Settings**.

| Action | SerpApi searches used |
| --- | --- |
| Flights for a date | 0 (free) |
| Cheapest-dates calendar | 1 |
| Hotels for a date | 1 |
| Opening a one-way flight / round trip (site comparison) | 2 / 3 |
| "Compare all sites now" on a saved flight | 2 to 3 |

Repeating the same search within 6 hours is free (it's cached). The top-right corner
shows how many SerpApi searches you've used this month.

## How the "full price" works

Google Flights lists each site selling a flight with that site's fare (taxes included).
The app adds checked-bag fees: if the site says what a bag costs, that number is used;
otherwise it uses the airline's typical fee from `bag_fees.json` (editable in Settings) and
marks it **est.** Card or payment surcharges aren't included.

## Files

- `app.py`: the web server and API
- `googleflights.py`: free Google Flights lookups
- `providers.py`: picks free Google Flights or SerpApi for each job
- `pricing.py` + `bag_fees.json`: works out all-in prices
- `tracker.py`: saved flights and their price history
- `cities.py`: city names to airport codes (add more cities here)
- `static/`: the web page
- `flights.db`: your saved searches and price history (created on first run)
