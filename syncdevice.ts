import { Client } from '@notionhq/client'
import { mdToPdf } from 'md-to-pdf'
import fs from 'fs'
import FormData from 'form-data'
import fetch from 'node-fetch'
import 'dotenv/config'
import { openAsBlob } from "node:fs"
import axios from 'axios'
import { spawn } from 'node:child_process'
import { createWorker } from 'tesseract.js'
import path from 'node:path'
import { pdfToPng, PngPageOutput } from 'pdf-to-png-converter'
import vision from '@google-cloud/vision'
import OpenAI from 'openai'
import { markdownToBlocks } from '@tryfabric/martian'
import { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints'

const notion = new Client({
    auth: process.env.NOTION_TOKEN
})

const openai_client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // This is the default and can be omitted
});

const notionBlocksToMarkdown = (blocks: any): string => {
    const markdownLines = blocks.map((block: any) => {
      switch (block.type) {
        case 'paragraph':
          return block.paragraph.rich_text.map((text: any) => text.text.content).join('');
        case 'heading_1':
          return `# ${block.heading_1.rich_text.map((text: any) => text.text.content).join('')}`;
        case 'heading_2':
          return `## ${block.heading_2.rich_text.map((text: any) => text.text.content).join('')}`;
        case 'heading_3':
          return `### ${block.heading_3.rich_text.map((text: any) => text.text.content).join('')}`;
        case 'bulleted_list_item':
          return `- ${block.bulleted_list_item.rich_text.map((text: any) => text.text.content).join('')}`;
        case 'numbered_list_item':
          return `1. ${block.numbered_list_item.rich_text.map((text: any) => text.text.content).join('')}`;
        case 'quote':
          return `> ${block.quote.rich_text.map((text: any) => text.text.content).join('')}`;
        // Add more cases for other block types if needed
        default:
          return '';
      }
    });
  
    return markdownLines.join('\n');
}

type RemarkableBlock = { ID: string, Parent: string, VissibleName: string, ModifiedClient: string }

const getRemarkableDocuments = async (id?: string): Promise<RemarkableBlock[]> => {
    let res = await axios.request({
        timeout: 2000,
        url: "http://10.11.99.1/documents/" + (id ? id : ""),
        headers: {
          "accept": "*/*",
          "accept-language": "en,en-US;q=0.9,fr;q=0.8",
          "Referer": "http://10.11.99.1/",
          "Referrer-Policy": "strict-origin-when-cross-origin"
        },
        method: "GET"
    })
    if (res.status != 200) {
        throw new Error("Device documents unable to retrieve via USB.")
    }

    return res.data
}

const uploadFileToRemarkable = async (fileName: string) => {
    let data = new FormData()
    data.append("file", fs.createReadStream(fileName))
    let res = await axios.request({
        url: "http://10.11.99.1/upload",
        timeout: 2000,
        headers: {
            "Connection": "keep-alive",
            "accept": "*/*",
            "accept-language": "en,en-US;q=0.9,fr;q=0.8",
            "Referer": "http://10.11.99.1/",
            "Origin": "http://10.11.99.1/",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            ...data.getHeaders()
        },
        data: data,
        method: 'post',
    });
    if (res.status != 201) {
        throw new Error("Unable to upload daily report.")
    }
}

const downloadRemarkableDocument = async (id: string, displayName: string) => {
    spawn(`curl`, ['-o', `./${displayName}.pdf`, `http://10.11.99.1/download/${id}/placeholder` ]).on("error", err => {
        throw err
    })
}

const syncJournal = async () => {
    console.log("Syncing journal...")
    return sync("Journal", ["Dreams", "Entry", "Goals for Tomorrow"], process.env.NOTION_JOURNAL_DATABASE_ID)
}

const syncMusicLog = async () => {
    console.log("Syncing music log...")
    return sync("Music/Practice Log", ["Time Allocation", "Goals for Tomorrow", "Notes"], process.env.NOTION_PRACTICE_LOG_DATABASE_ID)
}

function sleep(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
}

const sync = async (remarkable_parent_folder: string, categories: string[], notion_database_id?: string) => {
    let folder_split = remarkable_parent_folder.split("/")
    let today = new Date()
    let yesterday = new Date(today.getDate() - 1)
    if (!notion_database_id)
        throw new Error('NOTION_JOURNAL_DATABASE_ID is not set')
    
    let parsedData = await getRemarkableDocuments()
    if (parsedData.length == 0) throw new Error("Unable to retrieve Remarkable documents.")
    let parent_id = ""
    for (let i=0; i<folder_split.length; i++) {
        let temp_id = parsedData.filter(doc => doc.VissibleName == folder_split[i]).map(doc => doc.ID)
        if (temp_id.length == 0) return 
        parent_id = temp_id[0]
        parsedData = await getRemarkableDocuments(parent_id)
    }
    
    let child_id = parsedData.filter(doc => {
        let date = new Date(doc.ModifiedClient)
        return doc.Parent == parent_id && date > yesterday
    }).map(doc => ({ id: doc.ID, displayName: doc.VissibleName.replace("/", "-").replace("/", "-") }))
    if (child_id.length == 0) return
    await Promise.all(child_id.map(obj => downloadRemarkableDocument(obj.id, obj.displayName)))
    await sleep(1000)
    let pages = await notion.databases.query({
        database_id: notion_database_id,
    })

    for (let i=0; i<child_id.length; i++) {
    // for (let i=0; i<1; i++) {
        let finalText = ""
        let entry_date = new Date(child_id[i].displayName)
        let target = pages.results.filter(page => {
            if ("properties" in page) {
                let date = new Date((page.properties.Name as any).title[0].text.content)
                return date.getDate() == entry_date.getDate() && date.getMonth() == entry_date.getMonth() && date.getFullYear() == entry_date.getFullYear()
            }
    
            return false
        })

        let pngPages = await pdfToPng(`./${child_id[i].displayName}.pdf`)
        const getTextFromPage = async (page: PngPageOutput) => {
            let client = new vision.ImageAnnotatorClient()
            let imagePath = "./" + page.name + ".png"
            fs.writeFileSync(imagePath, page.content)
            const [result] = await client.textDetection(imagePath)
            fs.unlinkSync(imagePath)
            return result.fullTextAnnotation && result.fullTextAnnotation.text ? result.fullTextAnnotation.text : ""
        }

        let pageTexts = await Promise.all(pngPages.map(async page => getTextFromPage(page)))
        if (target.length > 0) {
            let page_children = await notion.blocks.children.list({
                block_id: target[0].id
            })
           
            let markdown = notionBlocksToMarkdown(page_children.results)
            // consolidate markdown and text
            let chatCompletion = await openai_client.chat.completions.create({
                messages: [{ role: 'user', content: markdown + '\n' + pageTexts.join('\n') + `Consolidate the above into the categories ${categories.map((cat, index) => index == categories.length - 1 ? cat : cat + ", ")} Dreams, Entry, and Goals for Tomorrow. Respond in format ${categories.map(cat => "**" + cat + "**:\n [text]\n")}. If nothing exists for the category, leave it blank.` }],
                model: 'gpt-3.5-turbo'
            })

            if (chatCompletion.choices[0].message.content)
                finalText = chatCompletion.choices[0].message.content
        } else {
            // consolidate text
            if (pageTexts.length < 2) {
                finalText = pageTexts[0]
            } else {
                let chatCompletion = await openai_client.chat.completions.create({
                    messages: [{ role: 'user', content: pageTexts.join('\n') + `Consolidate the above into the categories ${categories.map((cat, index) => index == categories.length - 1 ? cat : cat + ", ")} Dreams, Entry, and Goals for Tomorrow. Respond in format ${categories.map(cat => "**" + cat + "**:\n [text]\n")}. If nothing exists for the category, leave it blank.` }],
                    model: 'gpt-3.5-turbo'
                })
                
                if (chatCompletion.choices[0].message.content)
                    finalText = chatCompletion.choices[0].message.content
            }
        }

        if (finalText != "") {
            if (target.length > 0) {
                let blocks = await notion.blocks.children.list({
                    block_id: target[0].id
                })
                for (let j=0; j<blocks.results.length; j++) {
                    notion.blocks.delete({
                        block_id: blocks.results[j].id
                    })
                    await sleep(250)
                }

                await notion.blocks.children.append({
                    block_id: target[0].id,
                    children: markdownToBlocks(finalText) as BlockObjectRequest[],
                })
                console.log("Success in syncing ", remarkable_parent_folder)
            } else {
                await notion.pages.create({
                    parent: {
                        database_id: notion_database_id,
                    },
                    properties: {
                        Name: {
                            type: 'title',
                            title: [
                                {
                                  type: 'text',
                                  text: {
                                    content: (entry_date.getMonth() + 1) + "/" + entry_date.getDate() + "/" + entry_date.getFullYear().toString().slice(2, 4),
                                  },
                                },
                            ],
                        },
                    },
                    children: markdownToBlocks(finalText) as BlockObjectRequest[],
                })

                console.log("Success in syncing ", remarkable_parent_folder)
            }
        }
    }    

    child_id.forEach(child => {
        fs.unlinkSync(`./${child.displayName}.pdf`)
    })
}

const syncReport = async () => {
    console.log("Syncing news report...")
    let today = new Date()
    let report_name = `Daily Report (${today.getMonth() + 1}-${today.getDate()}-${today.getFullYear()})`
    if (!process.env.NOTION_DAILY_UPDATE_DATABASE_ID) 
        throw new Error('NOTION_DAILY_UPDATE_DATABASE_ID is not set')

    let pages = await notion.databases.query({
        database_id: process.env.NOTION_DAILY_UPDATE_DATABASE_ID,
    })

    let target = pages.results.filter(page => {
        if ("properties" in page) {
            let date = new Date((page.properties.Date as any).date.start)
            return date.getDate() == today.getDate() && date.getMonth() == today.getMonth() && date.getFullYear() == today.getFullYear()
        }

        return false
    })

    if (target.length > 0) {
        let page_children = await notion.blocks.children.list({
            block_id: target[0].id
        })
       
        let markdown = notionBlocksToMarkdown(page_children.results)
        fs.writeFileSync('report.md', markdown)
        let pdf_file = await mdToPdf({ path: 'report.md' })
        if (pdf_file) {
            fs.writeFileSync(`${report_name}.pdf`, pdf_file.content)
        }
        fs.unlinkSync('report.md')
    } else return

    let folderSet = false
    let parsedData = await getRemarkableDocuments()
    if (!parsedData) throw new Error("Unable to retrieve Remarkable documents.")
    for (let i=0; i<parsedData.length; i++) {
        if (parsedData[i].VissibleName == "News") {
            let newsRes = await fetch("http://10.11.99.1/documents/" + parsedData[i].ID, {
                "headers": {
                  "accept": "*/*",
                  "accept-language": "en,en-US;q=0.9,fr;q=0.8",
                  "Referer": "http://10.11.99.1/",
                  "Referrer-Policy": "strict-origin-when-cross-origin"
                },
                "method": "GET"
            });
            if (!newsRes.ok) {
                throw new Error("Unable to retrieve info about News folder.")
            }

            folderSet = true
        }
    }

    if (folderSet) await uploadFileToRemarkable(`${report_name}.pdf`)
    else throw new Error("Unable to find News folder.")
    fs.unlinkSync(`${report_name}.pdf`)
}

const main = async () => {
    try {
        let res = await fetch('http://10.11.99.1/')
        if (!res.ok) {
            throw new Error("Device not available via usb.")
        }
        await Promise.all([
            syncJournal(),
            syncMusicLog(),
            syncReport()
        ])
    } catch (error) {
        console.error(error)
    }
}

main()

