/**
 * Main application module
 */
'use strict';
// Если на сервере нет валидного сертификата, то приходится игнорировать
// неавторизованное соединение
// http://stackoverflow.com/questions/20082893/unable-to-verify-leaf-signature
// TODO: disable in production
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('./promise-finally');
const IMAP = require('./imap');
/**
 * Algorithm:
 * 1. Check if all mailboxes exist, exit with warning if some do not
 * 2. Open a box, then process its emails
 * 3. When done processing, close the box
 * 4. Open another box, process its emails
 * 5. When no more boxes are left, wait for the timeout
 * 6. After the timeout is reached, start all over again
 */

// HISTORY:
// Process mailboxes in a cycle - DONE
// Parse the message body - DONE
// Create an issue with defaults - DONE
// Download and pipe attachments - DONE
// Add saving external_id = message.uid to zIssues - DONE
// Create a universal Winston logging driver - DONE
// Refactor findAttachmentParts - DONE
// Change the attribute SEEN for read messages - DONE
// Parse and save additional attributes from the body - DONE
// Parse the requestId in the message subject and
//   save a comment with [authorId, description, attachment] - DONE
// Cut off the rest of the message matching a specific `cut-off` string - DONE
// Save original email as an *.eml attachment - DONE
// Check files by opening them on the client - DONE
// Get rid of using the filesystem to save attachments - DONE
// Make a class to handle several servers - PENDING
// Spam config:
//  - query the database - DONE
//  - check the auto-reply headers - DONE
// Remove parsed fields from the message body - CANCELLED, use the truncate delimiters
// Add <br> to the text messages - DONE
// Adjust dates passed as parameters for the user's timezone - DONE
// Disable the spam test for the system user - DONE
// Make use of mailparser for decoding message bodies - DONE
// Make use of mailparser for decoding attachments - DONE

IMAP.run();

if (process.platform === 'win32') {
    require('readline')
        .createInterface({
            input: process.stdin,
            // stdout генерирует ошибку в node 5.6
            //output: process.stdout
        })
        .on('SIGINT', function () {
            process.emit('SIGINT');
        });
}

process.on('SIGINT', function () {
    // graceful shutdown
    IMAP
        .stop()
        .then(() => {
            console.log('Node-imap server shut down');
            process.exit(0);
        })
        .catch(() => process.exit(1));
});
