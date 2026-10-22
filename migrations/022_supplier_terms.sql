-- Supplier card: client account number, billing currency, payment terms, whether purchases
-- are authorized (negotiated agreement) and main purchasing category.
IF COL_LENGTH(N'dbo.PromographeSuppliers', N'AccountNumber') IS NULL
BEGIN
  ALTER TABLE dbo.PromographeSuppliers ADD
    AccountNumber nvarchar(50) NOT NULL CONSTRAINT DF_PromographeSuppliers_AccountNumber DEFAULT N'',
    Currency nvarchar(3) NOT NULL CONSTRAINT DF_PromographeSuppliers_Currency DEFAULT N'CAD',
    PaymentTerms nvarchar(50) NOT NULL CONSTRAINT DF_PromographeSuppliers_PaymentTerms DEFAULT N'',
    IsAuthorized bit NOT NULL CONSTRAINT DF_PromographeSuppliers_IsAuthorized DEFAULT 1,
    Category nvarchar(100) NOT NULL CONSTRAINT DF_PromographeSuppliers_Category DEFAULT N'';
END;
