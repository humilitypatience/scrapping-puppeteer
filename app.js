const express = require("express");
const app = express();
const cron = require("node-cron");
const { Cluster } = require("puppeteer-cluster");
const updateTime = "*/4 * * * *";

const tradersUrl = "https://www.bitget.com/en/copytrading/futures";
const serverStartedTime = new Date();

app.get("/", (req, res) => {});

app.listen(3001, () => {
  console.log("Sever is running");
});

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

require("dotenv").config();
const creds = require("./cred.json");
const moment = require("moment");
puppeteer.use(StealthPlugin());

const { GoogleSpreadsheet } = require("google-spreadsheet");
const doc = new GoogleSpreadsheet(process.env.GOOGLE_DOC_ID);

const { google } = require("googleapis");

const authentication = async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: "cred.json",
    scopes: "https://www.googleapis.com/auth/spreadsheets"
  });

  const client = await auth.getClient();

  const sheets = google.sheets({
    version: "v4",
    auth: client
  });
  return {
    sheets
  };
};

const createRows = async (sheetName, jsonData) => {
  await doc.useServiceAccountAuth(creds);

  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[sheetName];
  const newRow = await sheet.addRows(jsonData, {
    insert: true,
    raw: true
  });
  // console.log('add rows')
};

const clearRows = async (doc, sheetName) => {
  const { sheets } = await authentication();
  const spreadsheetId = process.env.GOOGLE_DOC_ID;
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    includeGridData: false
  });
  const sheetsInfo = response.data.sheets;
  const sheet = sheetsInfo.find((s) => s.properties.title === sheetName);
  const sheetId = sheet ? sheet.properties.sheetId : null;

  const numRows = (
    await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:A`
    })
  ).data.values.length;

  const request = {
    spreadsheetId,
    resource: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetId,
              dimension: "ROWS",
              startIndex: 1,
              endIndex: numRows
            }
          }
        },
        {
          updateCells: {
            range: {
              sheetId: sheetId,
              startRowIndex: 1,
              startColumnIndex: 0
            },
            fields: "userEnteredValue,userEnteredFormat.backgroundColor"
          }
        }
      ]
    }
  };
  try {
    await sheets.spreadsheets.batchUpdate(request);
    // console.log(`Cleared data with color format from ${sheetName} sheet.`)
  } catch (err) {
    // console.error(err.message)
  }
};

const getUrls = async (tradersUrl) => {
  const browser = await puppeteer.launch({
    headless: "new",
    // userDataDir: "./userdata",
    args: ["--no-sandbox"]
  });

  const [page] = await browser.pages();
  page.setViewport({
    width: 1200,
    height: 700
  });

  await page.goto(tradersUrl, {
    waitUntil: "domcontentloaded"
  });
  await page.waitForSelector(".link-text");
  const urls = await page.evaluate(() => {
    const urlSets = document.querySelectorAll(".link-text");
    const urlArrays = Array.from(urlSets);
    return urlArrays.map((url) => url.getAttribute("href"));
  });
  browser.close();
  return urls;
};

const getDataAndWriteToSheet = async () => {
  const urls = await getUrls(tradersUrl);
  console.log(urls);
  await manageUrl(urls);
};

const manageUrl = async (urls) => {
  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    puppeteerOptions: {
      headless: "new",
      args: ["--no-sandbox"]
    },
    maxConcurrency: 1000
  });

  await cluster.task(async ({ page, data: url }) => {
    console.log("page: ", url)
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const traderName = await page.$eval(
      "span.trader-home-banner__name",
      (element) => element.textContent.trim()
    );
    console.log("traderNmae: ", traderName)
    await page.waitForSelector(
      ".trader-home-tabs .tabs-block-item:nth-child(2)"
    );
    await page.click(".trader-home-tabs .tabs-block-item:nth-child(2)");
    await page
      .waitForSelector(".contractType", {
        timeout: 10000
      })
      .catch(() => {
        console.log("Timeout: ", url);
        throw ("Time out: ", url);
      });
    console.log("goto: ", url)
    let historySets = await page.evaluate(() => {
      let historySetsElements = document.querySelectorAll(
        ".list-box-container"
      );
      let historySetsArray = Array.from(historySetsElements);
      historySetsArray.shift();
      historySetsArray.pop();
      return historySetsArray.map((element) => {
        const ticker = element
          .querySelector(".contractType")
          .textContent.includes("BTC")
          ? "BTC"
          : "ETH";
        return {
          Direction: element.querySelector(".dirction").textContent.trim(),
          Ticker: ticker,
          "Open Price": element
            .querySelector(".list-box-container__item-openAvgPrice")
            .textContent.trim()
            .replace(/[a-zA-Z]/g, ""),
          "Close Price": element
            .querySelector(".list-box-container__item-closeAvgPrice")
            .textContent.trim()
            .replace(/[a-zA-Z]/g, ""),
          ROI: element
            .querySelector(".list-box-container__item:nth-child(4)")
            .textContent.trim(),
          closeTime: element
            .querySelector(".list-box-container__item-closeTime")
            .textContent.trim()
        };
      });
    });
    historySets = historySets
      .filter((item) => {
        const ct = new Date(item.closeTime);
        ct.setFullYear(serverStartedTime.getFullYear());
        return ct < serverStartedTime;
      })
      .map((item) => {
        return {
          ...item,
          "Trader Name": traderName,
          Date: moment(item.closeTime, "M/D HH:mm:ss").format("MM/DD/YYYY"),
          Time: moment(item.closeTime, "M/D HH:mm:ss").format("hh:mm a")
        };
      });
    console.log("Url: ", url, historySets);
    // await page.click(".trader-order-tabs .tabs-block-item:nth-child(2)");
    // await page
    //   .waitForSelector(".contractType", {
    //     timeout: 10000
    //   })
    //   .catch(() => {
    //     return;
    //   });
  });

  for (let i = 0; i < urls.length; i++) {
    cluster.queue("https://www.bitget.com" + urls[i]);
  }

  await cluster.idle();
  await cluster.close();

  // await page.waitForSelector(".trader-home-tabs .tabs-block-item:nth-child(2)");
  // const traderName = await page.$eval(
  //   "span.trader-home-banner__name",
  //   (element) => element.textContent.trim()
  // );
  // await page.click(".trader-home-tabs .tabs-block-item:nth-child(2)");
  // await page
  //   .waitForSelector(".contractType", {
  //     timeout: 10000
  //   })
  //   .catch(() => {
  //     console.log("Timeout: ", url);
  //     throw ("Time out: ", url);
  //   });

  // let historySets = await page.evaluate(() => {
  //   let historySetsElements = document.querySelectorAll(".list-box-container");
  //   let historySetsArray = Array.from(historySetsElements);
  //   historySetsArray.shift();
  //   historySetsArray.pop();
  //   return historySetsArray.map((element) => {
  //     const ticker = element
  //       .querySelector(".contractType")
  //       .textContent.includes("BTC")
  //       ? "BTC"
  //       : "ETH";
  //     return {
  //       Direction: element.querySelector(".dirction").textContent.trim(),
  //       Ticker: ticker,
  //       "Open Price": element
  //         .querySelector(".list-box-container__item-openAvgPrice")
  //         .textContent.trim()
  //         .replace(/[a-zA-Z]/g, ""),
  //       "Close Price": element
  //         .querySelector(".list-box-container__item-closeAvgPrice")
  //         .textContent.trim()
  //         .replace(/[a-zA-Z]/g, ""),
  //       ROI: element
  //         .querySelector(".list-box-container__item:nth-child(4)")
  //         .textContent.trim(),
  //       closeTime: element
  //         .querySelector(".list-box-container__item-closeTime")
  //         .textContent.trim()
  //     };
  //   });
  // });
  // historySets = historySets
  //   .filter((item) => {
  //     const ct = new Date(item.closeTime);
  //     ct.setFullYear(serverStartedTime.getFullYear());
  //     return ct < serverStartedTime;
  //   })
  //   .map((item) => {
  //     return {
  //       ...item,
  //       "Trader Name": traderName,
  //       Date: moment(item.closeTime, "M/D HH:mm:ss").format("MM/DD/YYYY"),
  //       Time: moment(item.closeTime, "M/D HH:mm:ss").format("hh:mm a")
  //     };
  //   });
  // console.log("Url: ", url, historySets)
  // await page.click('.trader-order-tabs .tabs-block-item:nth-child(2)')
  // await page
  //     .waitForSelector('.contractType', {
  //         timeout: 10000
  //     })
  //     .catch(() => {
  //         return
  //     })

  // let informationSets = await page.evaluate(() => {
  //     let informationSetsElements = document.querySelectorAll(
  //         '.list-box-container'
  //     )
  //     let informationSetsArray = Array.from(informationSetsElements)
  //     informationSetsArray.shift()
  //     return informationSetsArray.map(element => {
  //         const ticker = element
  //             .querySelector('.contractType')
  //             .textContent.includes('BTC') ?
  //             'BTC' :
  //             'ETH'
  //         return {
  //             Direction: element.querySelector('.dirction').textContent.trim(),
  //             Ticker: ticker,
  //             'Open Price': element
  //                 .querySelector('.list-box-container__item-openAvgPrice')
  //                 .textContent.trim()
  //                 .replace(/[a-zA-Z]/g, ''),
  //             'Current Price': element
  //                 .querySelector('.list-box-container__item-market-price')
  //                 .textContent.trim()
  //                 .replace(/[a-zA-Z]/g, ''),
  //             ROI: element
  //                 .querySelector('.list-box-container__item:nth-child(4) span')
  //                 .textContent.trim(),
  //             openTime: element
  //                 .querySelector('.list-box-container__item-openTime')
  //                 .textContent.trim()
  //         }
  //     })
  // })
  // informationSets = informationSets.map(item => {
  //     // console.log(item)
  //     return {
  //         ...item,
  //         'Trader Name': traderName,
  //         Date: moment(item.openTime, 'M/D HH:mm:ss').format('MM/DD/YYYY'),
  //         Time: moment(item.openTime, 'M/D HH:mm:ss').format('hh:mm a')
  //     }
  // })
  // let btcSets = informationSets.filter(item => item.Ticker === 'BTC')
  // let ethSets = informationSets.filter(item => item.Ticker === 'ETH')
  // await createRows('BTC', btcSets)
  // await createRows('ETH', ethSets)
  //await createRows("Trade History", historySets);
};
// cron.schedule(updateTime, async () => {
//     // await clearRows(undefined, 'BTC')
//     // await clearRows(undefined, 'ETH')
//     // await clearRows(undefined, 'Trade History')
//     await getDataAndWriteToSheet()
// })

getDataAndWriteToSheet();
