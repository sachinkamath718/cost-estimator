require("dotenv").config();
const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const { PricingClient, GetProductsCommand } = require("@aws-sdk/client-pricing");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── AWS Pricing Client ────────────────────────────────────────────────────────
const pricingClient = new PricingClient({
  region: "us-east-1",
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── MSK Serverless Pricing (live AWS SDK) ─────────────────────────────────────
app.get("/api/msk-prices", async (req, res) => {
  const region = req.query.region || "ap-south-1";
  try {
    const command = new GetProductsCommand({
      ServiceCode: "AmazonMSK",
      Filters: [{ Type: "TERM_MATCH", Field: "regionCode", Value: region }],
      MaxResults: 100,
    });
    const data     = await pricingClient.send(command);
    const products = data.PriceList.map(p => JSON.parse(p));

    let clusterHour = 0, partitionHour = 0, storagePGB = 0, dataInPGB = 0, dataOutPGB = 0;

    for (const p of products) {
      const onDemand = Object.values(p.terms?.OnDemand || {})[0];
      const priceDim = Object.values(onDemand?.priceDimensions || {})[0];
      const usd      = parseFloat(priceDim?.pricePerUnit?.USD || 0);
      const desc     = (priceDim?.description || "").toLowerCase();
      const op       = (p.product?.attributes?.operation || "").toLowerCase();

      if (op !== "serverless") continue;

      if      (desc.includes("cluster-hour"))   clusterHour   = usd;
      else if (desc.includes("partition-hour")) partitionHour = usd;
      else if (desc.includes("storage"))        storagePGB    = usd;
      else if (desc.includes("data in"))        dataInPGB     = usd;
      else if (desc.includes("data out"))       dataOutPGB    = usd;
    }

    const available = clusterHour > 0 || partitionHour > 0;
    res.json({ available, clusterHour, partitionHour, storagePGB, dataInPGB, dataOutPGB, region });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Azure Event Hubs Pricing (proxied to avoid CORS) ─────────────────────────
app.get("/api/azure-prices", async (req, res) => {
  const region = req.query.region || "southindia";
  try {
    const filter = encodeURIComponent(
      `serviceName eq 'Event Hubs' and armRegionName eq '${region}'`
    );
    const url  = `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=${filter}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const items = data.Items || [];

    let cuPrice = null, ovPrice = null, geoPrice = null;

    for (const item of items) {
      const name  = (item.skuName   || "").toLowerCase();
      const meter = (item.meterName || "").toLowerCase();
      const type  = (item.type      || "").toLowerCase();
      if (type === "reservation") continue;

      if (
  (name.includes("dedicated") || name.includes("capacity unit") || meter.includes("dedicated capacity")) &&
  (meter.includes("hour") || item.unitOfMeasure === "1 Hour") &&
  item.retailPrice > 0
) {
  cuPrice = item.retailPrice;
}
      if (
  (name.includes("overage") || meter.includes("overage")) &&
  !meter.includes("hour") &&
  item.retailPrice > 0
) {
  ovPrice = item.retailPrice;
}
      if (meter.includes("geo") || name.includes("geo"))
        geoPrice = item.retailPrice;
    }

    res.json({
      cuPrice:      cuPrice  || 8.768,
      ovPrice:      ovPrice  || 0.15,
      geoPrice:     geoPrice || 0.09,
      region,
      fetchedAt:    new Date().toISOString(),
      usedFallback: !cuPrice,
    });
  } catch (err) {
    res.json({ cuPrice: 8.768, ovPrice: 0.15, geoPrice: 0.09, region, usedFallback: true, error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    hasAwsKeys: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
  });
});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n  Kafka Pricing Calculator`);
  console.log(`  Running at http://localhost:${PORT}`);
  console.log(`  AWS keys: ${process.env.AWS_ACCESS_KEY_ID ? "✓ loaded" : "✗ missing"}\n`);
});