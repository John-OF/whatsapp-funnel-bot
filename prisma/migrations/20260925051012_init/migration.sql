-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "waId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "consentAt" DATETIME,
    "consentVersion" TEXT,
    "step" TEXT NOT NULL DEFAULT 'WELCOME',
    "stepData" TEXT NOT NULL DEFAULT '{}',
    "invalidInputCount" INTEGER NOT NULL DEFAULT 0,
    "diagnosticScore" INTEGER,
    "diagnosticAnswers" TEXT NOT NULL DEFAULT '[]',
    "hubspotContactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "clientTransactionId" TEXT NOT NULL,
    "paymentUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerTransactionId" TEXT,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessedMessage" (
    "waMessageId" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_waId_key" ON "User"("waId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientTransactionId_key" ON "Order"("clientTransactionId");
