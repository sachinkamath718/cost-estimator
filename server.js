require("dotenv").config();
const express = require("express");
const cors = require('cors'); 
const fetch   = require("node-fetch");
const path    = require("path");
const { PricingClient, GetProductsCommand } = require("@aws-sdk/client-pricing");

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors()); 
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

// ── Redpanda Cloud Pricing ────────────────────────────────────────────────────
const RP_RATES = {
  "us-east-1":      { label: "N. Virginia",  clusterHr: 0.10,  partitionHr: 0.0015, gbWritten: 0.045,  gbRead: 0.04,   gbMonthRet: 0.09   },
  "us-west-2":      { label: "Oregon",       clusterHr: 0.10,  partitionHr: 0.0015, gbWritten: 0.045,  gbRead: 0.04,   gbMonthRet: 0.09   },
  "eu-central-1":   { label: "Frankfurt",    clusterHr: 0.12,  partitionHr: 0.0018, gbWritten: 0.054,  gbRead: 0.048,  gbMonthRet: 0.1053 },
  "eu-west-2":      { label: "London",       clusterHr: 0.198, partitionHr: 0.003,  gbWritten: 0.0891, gbRead: 0.0792, gbMonthRet: 0.1773 },
  "ap-south-1":     { label: "Mumbai",       clusterHr: 0.066, partitionHr: 0.001,  gbWritten: 0.03,   gbRead: 0.026,  gbMonthRet: 0.0594 },
  "ap-southeast-1": { label: "Singapore",    clusterHr: 0.125, partitionHr: 0.0019, gbWritten: 0.0563, gbRead: 0.05,   gbMonthRet: 0.1125 },
  "ap-northeast-1": { label: "Tokyo",        clusterHr: 0.129, partitionHr: 0.0019, gbWritten: 0.0581, gbRead: 0.0516, gbMonthRet: 0.1161 },
};
const RP_FALLBACK_REGION = "eu-west-2"; // most expensive — safe upper bound
const RP_HOURS = 730, RP_MB_PER_GB = 1000, RP_PARTITIONS = 1000;
const RP_PL_HOURLY = 0.05, RP_PL_DATA = 0.02;

function rpMbpsToGb(mbps) { return (mbps * 3600 * RP_HOURS) / RP_MB_PER_GB; }

app.post("/api/redpanda-calculate", (req, res) => {
  const { region, throughput, retention, replicas } = req.body;
  const usedFallback = !RP_RATES[region];
  const effectiveRegion = RP_RATES[region] ? region : RP_FALLBACK_REGION;
  const r = RP_RATES[effectiveRegion];

  const writeMBps = parseFloat(throughput);
  const readMBps  = writeMBps;
  const totalMBps = writeMBps + readMBps;
  const gbWrittenPerMonth = rpMbpsToGb(writeMBps);
  const gbReadPerMonth    = rpMbpsToGb(readMBps);
  const gbWrittenBilled   = gbWrittenPerMonth * replicas;
  const gbPerDay          = (writeMBps * 3600 * 24) / RP_MB_PER_GB;
  const gbMonthStored     = gbPerDay * retention * replicas;
  const totalGbPerMonth   = rpMbpsToGb(totalMBps);

  const clusterCost   = r.clusterHr   * RP_HOURS;
  const partitionCost = r.partitionHr * RP_PARTITIONS * RP_HOURS;
  const writeCost     = r.gbWritten   * gbWrittenBilled;
  const readCost      = r.gbRead      * gbReadPerMonth;
  const retentionCost = r.gbMonthRet  * gbMonthStored;
  const plUptimeCost  = RP_PL_HOURLY  * RP_HOURS;
  const plDataCost    = RP_PL_DATA    * totalGbPerMonth;
  const privatelinkCost = plUptimeCost + plDataCost;
  const total = clusterCost + partitionCost + writeCost + readCost + retentionCost + privatelinkCost;

  res.json({
    region: effectiveRegion, regionLabel: r.label,
    usedFallback, requestedRegion: region,
    rates: { clusterHr: r.clusterHr, partitionHr: r.partitionHr, gbWritten: r.gbWritten, gbRead: r.gbRead, gbMonthRet: r.gbMonthRet },
    breakdown: [
      { name: "Cluster uptime",   detail: `$${r.clusterHr}/hr × ${RP_HOURS} hrs`,                                               amount: +clusterCost.toFixed(2) },
      { name: "Partition hours",  detail: `$${r.partitionHr}/partition/hr × ${RP_PARTITIONS} × ${RP_HOURS} hrs`,               amount: +partitionCost.toFixed(2) },
      { name: "Data written",     detail: `$${r.gbWritten}/GB × ${gbWrittenBilled.toFixed(2)} GB (×${replicas} replicas)`,      amount: +writeCost.toFixed(2) },
      { name: "Data read",        detail: `$${r.gbRead}/GB × ${gbReadPerMonth.toFixed(2)} GB`,                                  amount: +readCost.toFixed(2) },
      { name: "Retention storage",detail: `$${r.gbMonthRet}/GB-month × ${gbMonthStored.toFixed(2)} GB`,                        amount: +retentionCost.toFixed(2) },
      { name: "PrivateLink",      detail: `$${plUptimeCost.toFixed(2)} uptime + $${plDataCost.toFixed(2)} data`,               amount: +privatelinkCost.toFixed(2) },
    ],
    total: +total.toFixed(2),
  });
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
