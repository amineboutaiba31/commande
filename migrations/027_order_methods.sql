-- Purchase orders are no longer sent by text message or phone (company decision, 2026-10-21):
-- supplier cards that preferred them go back to "Non précisé". Purchase orders already sent keep
-- the way they were sent.
UPDATE dbo.PromographeSuppliers SET OrderMethod = N'' WHERE OrderMethod IN (N'sms', N'phone');
