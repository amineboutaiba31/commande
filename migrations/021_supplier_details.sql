-- Supplier card: phone extension, internal note, and the order amounts from which shipping
-- is reduced or free.
IF COL_LENGTH(N'dbo.PromographeSuppliers', N'PhoneExtension') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeSuppliers ADD
    PhoneExtension nvarchar(20) NOT NULL CONSTRAINT DF_PromographeSuppliers_PhoneExtension DEFAULT N'',
    Note nvarchar(1000) NOT NULL CONSTRAINT DF_PromographeSuppliers_Note DEFAULT N'',
    ReducedShippingThresholdCents int NULL,
    FreeShippingThresholdCents int NULL;
END;
