// Parses the development application at the South Australian Adelaide Hills Council web site and
// places them in a database.
//
// Michael Bone
// 16th July 2018

let cheerio = require("cheerio");
let request = require("request-promise-native");
let sqlite3 = require("sqlite3").verbose();
let pdf2json = require("pdf2json");
let urlparser = require("url");
let moment = require("moment");

const DevelopmentApplicationsUrl = "https://www.ahc.sa.gov.au/Resident/planning-and-building/the-development-process/development-applications/development-applications-register";
const CommentUrl = "mailto:mail@ahc.sa.gov.au";

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text, [on_notice_from] text, [on_notice_to] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if it does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.reason,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate,
            null,
            null
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted new application \"${developmentApplication.applicationNumber}\" into the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Retrieve the page contain the link to the PDF.

	console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request(DevelopmentApplicationsUrl);
    let $ = cheerio.load(body);

	let relativePdfUrl = null;
	$("a[href$='.pdf']").each((index, element) => {
		if ($(element).text() === "Development Applications Register")
		    relativePdfUrl = element.attribs.href;
	});

	if (relativePdfUrl === null) {
		console.log("Could not find a link to the PDF that contains the development applications.");
		return;
	}

	let pdfUrl = new urlparser.URL(relativePdfUrl, DevelopmentApplicationsUrl)
	console.log(`Retrieving document: ${pdfUrl.href}`);

	// Parse the PDF into a collection of PDF rows.  Each PDF row is simply an array of strings,
	// being the text that has been parsed from the PDF.

	let pdfParser = new pdf2json();
	let pdfPipe = request({ url: pdfUrl.href, encoding: null }).pipe(pdfParser);
	pdfPipe.on("pdfParser_dataError", error => console.error(error))
	pdfPipe.on("pdfParser_dataReady", async pdf => {
        try
        {
            // Convert the JSON representation of the PDF into a collection of PDF rows.

            console.log(`Parsing document.`);
            let rows = convertPdfToText(pdf);

            for (let row of rows) {
                let receivedDate = moment(row[3].trim(), "D/MM/YYYY", true);  // allows the leading zero of the day to be omitted
                await insertRow(database, {
                    applicationNumber: row[2].trim(),
                    address: row[1].trim(),
                    reason: row[5].trim(),
                    informationUrl: pdfUrl.href,
                    commentUrl: CommentUrl,
                    scrapeDate: moment().format("YYYY-MM-DD"),
                    receivedDate: receivedDate.isValid ? receivedDate.format("YYYY-MM-DD") : ""
                });
            }
        } catch (ex) {
            console.error(ex);
        }
	});
}

// Convert a parsed PDF into an array of rows.  This function is based on pdf2table by Sam Decrock.
// See https://github.com/SamDecrock/pdf2table/blob/master/lib/pdf2table.js.
//
// Copyright (c) 2015 Sam Decrock <sam.decrock@gmail.com>
//
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

function convertPdfToText(pdf) {
    let xComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);

    // Find the smallest Y co-ordinate for two texts with equal X co-ordinates.

    let smallestYValueForPage = [];

    for (let pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        let page = pdf.formImage.Pages[pageIndex];
        let smallestYValue = null;  // per page
        let textsWithSameXValues = {};

        for (let textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            let text = page.Texts[textIndex];
            if (!textsWithSameXValues[text.x])
                textsWithSameXValues[text.x] = [];
            textsWithSameXValues[text.x].push(text);
        }

        // Find smallest Y distance.

        for (let x in textsWithSameXValues) {
            let texts = textsWithSameXValues[x];
            for (let i = 0; i < texts.length; i++) {
                for (let j = 0; j < texts.length; j++) {
                    if (texts[i] !== texts[j]) {
                        let distance = Math.abs(texts[j].y - texts[i].y);
                        if (smallestYValue === null || distance < smallestYValue)
                            smallestYValue = distance;
                    }
                };
            };
        }

        if (smallestYValue === null)
            smallestYValue = 0;
        smallestYValueForPage.push(smallestYValue);
    }

    // Find texts with similar Y values (in the range of Y - smallestYValue to Y + smallestYValue).

    let myPages = [];

    for (let pageIndex = 0; pageIndex < pdf.formImage.Pages.length; pageIndex++) {
        let page = pdf.formImage.Pages[pageIndex];

        let rows = [];  // store texts and their X positions in rows

        for (let textIndex = 0; textIndex < page.Texts.length; textIndex++) {
            let text = page.Texts[textIndex];

            let foundRow = false;
            for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
                // Y value of text falls within the Y value range, add text to row.

                let maximumYdifference = smallestYValueForPage[pageIndex];
                if (rows[rowIndex].y - maximumYdifference < text.y && text.y < rows[rowIndex].y + maximumYdifference) {
                    // Only add value of T to data (which is the actual text).

                    for (let index = 0; index < text.R.length; index++)
                        rows[rowIndex].data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                    foundRow = true;
                }
            };

            // Create a new row and add the text to the row.

            if (!foundRow) {
                let row = { y: text.y, data: [] };
                for (let index = 0; index < text.R.length; index++)
                    row.data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });
                rows.push(row);
            }
        };

        // Sort each extracted row horizontally by X co-ordinate.

        for (let index = 0; index < rows.length; index++)
            rows[index].data.sort(xComparer);

        // Sort rows vertically by Y co-ordinate.

        rows.sort(yComparer);

        // Add rows to pages.

        myPages.push(rows);
    };

    // Convert the pages into application number rows.

    let applicationNumberRow = null;
    let applicationNumberRows = [];

    for (let pageIndex = 0; pageIndex < myPages.length; pageIndex++) {
        for (let rowIndex = 0; rowIndex < myPages[pageIndex].length; rowIndex++) {
            // Now that each row is made of objects extract the text property from the object.

            let row = myPages[pageIndex][rowIndex].data;

            // Ignore the document heading.  Ignore page numbers and ignore column headings.

            if (row.length >= 1 &&
                (row[0].text.trim().startsWith("Development Application Register") ||
                row[0].text.trim().startsWith("- Page") ||
                row[0].text.trim() === "Applicant Name" ||
                row[0].text.trim() === "Address"))
                continue;

            if (row.length >= 3 && isApplicationNumber(row[2].text.trim())) {
                // Remember the last application number row that was encountered.  This will be
                // used to calibrate the positions of the columns (based on their X co-ordinates).

                applicationNumberRow = row;
                applicationNumberRows.push(applicationNumberRow);
            }
            else if (applicationNumberRow !== null) {
                for (let index = 0; index < row.length; index++) {
                    // Determine which column the current cell lines up with in the previously
                    // encountered application number row.  Add the text to that cell.

                    let haveFoundColumn = false;
                    for (let columnIndex = 0; columnIndex < applicationNumberRow.length; columnIndex++) {
                        if (Math.abs(applicationNumberRow[columnIndex].x - row[index].x) < 0.1) {  // arbitrary small value
                            applicationNumberRow[columnIndex].text += "\n" + row[index].text;
                            haveFoundColumn = true;
                            break;
                        }
                    }
                    
                    // Report any text for which an appropriate column was not found.

                    if (!haveFoundColumn)
                        console.log(`Ignored the text "${row[index].text}" from the row: ${row}`);
                }
            }
        };
    };

    // Remove the X co-ordinate information, to just return the resulting text for each cell.

    let rows = [];

    for (let rowIndex = 0; rowIndex < applicationNumberRows.length; rowIndex++) {
        let row = [];
        for (let columnIndex = 0; columnIndex < applicationNumberRows[rowIndex].length; columnIndex++)
            row.push(applicationNumberRows[rowIndex][columnIndex].text);
        rows.push(row);
    }

    return rows;
}

// Determines whether the specified text represents an application number.  A strict format of
// "nn/n", "nn/nn", "nn/nnn" or "nn/nnnn" is assumed.  For example, "17/67" or "17/1231".

function isApplicationNumber(text) {
    return /^[0-9][0-9]\/[0-9]{1,4}$/.test(text)
}

main().catch(error => console.error(error));
