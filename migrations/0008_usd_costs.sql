-- USD equivalents of cash_cost and upgrade_cash_cost, for stats. Filled automatically when the currency is USD;
-- for other currencies it is entered by hand (and cleared whenever the cost or currency changes, as it'd be stale).
ALTER TABLE flights ADD COLUMN cash_cost_usd REAL;
ALTER TABLE flights ADD COLUMN upgrade_cash_cost_usd REAL;
UPDATE flights SET cash_cost_usd = cash_cost WHERE cash_currency = 'USD' AND cash_cost IS NOT NULL;
UPDATE flights SET upgrade_cash_cost_usd = upgrade_cash_cost WHERE upgrade_cash_currency = 'USD' AND upgrade_cash_cost IS NOT NULL;
