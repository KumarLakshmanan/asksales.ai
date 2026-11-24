import multer from 'multer';
import type {Request} from 'express';

/** Aggregate stream budget prevents twenty individually valid files from
 * allocating 500 MB before the route can enforce its combined upload limit. */
const totals=new WeakMap<Request,number>();
const storage:multer.StorageEngine={
  _handleFile(req,file,callback) {
    const chunks:Buffer[]=[];let size=0,finished=false;
    const finish=(error:Error|null)=>{if(finished)return;finished=true;if(error){chunks.length=0;callback(error);}else callback(null,{buffer:Buffer.concat(chunks),size});};
    file.stream.on('data',(chunk:Buffer)=>{
      if(finished)return;
      size+=chunk.length;totals.set(req,(totals.get(req)||0)+chunk.length);
      if(totals.get(req)!>100*1024*1024){finish(new Error('Contact uploads must be at most 100 MB combined.'));return;}
      chunks.push(chunk);
    });
    file.stream.once('error',finish);file.stream.once('end',()=>finish(null));
  },
  _removeFile(_req,file,callback){delete (file as Partial<Express.Multer.File>).buffer;callback(null);},
};
export const contactWorkbookUpload=multer({storage,limits:{fileSize:25*1024*1024,files:20,fields:3,fieldSize:256*1024},
  fileFilter(_req,file,callback){
    if(!/\.(xlsx|xls|csv|tsv)$/i.test(file.originalname))return callback(new Error('Upload Excel, CSV or TSV contact files.'));
    callback(null,true);
  },
}).array('files',20);
